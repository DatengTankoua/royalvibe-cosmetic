import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PASSWORD_HASH_ROUNDS, dummyPasswordHash } from './password-hashing';
import { PersistentRateLimiter } from '../common/rate-limit/persistent-rate-limiter.service';
import {
  normalizeAccountEmail,
  resolveAntiAbuseConfig,
} from '../common/rate-limit/anti-abuse-config';
import {
  RateLimitedException,
  buildAuthChallengeRequiredBody,
  buildAuthRateLimitBody,
} from '../common/auth-rate-limiting';
import { TurnstileService } from '../anti-bot/turnstile.service';
import { TURNSTILE_LOGIN_ACTION } from '../anti-bot/turnstile-config';
import { UsersService } from '../users/users.service';
import { LegalAcceptanceService } from '../legal/legal-acceptance.service';
import { LegalAcceptanceContext } from '../legal/legal-documents';
import { isAppLocale } from '../common/i18n/locale';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SwitchOrganizationDto } from './dto/switch-organization.dto';
import { UserDocument, UserRole } from '../users/schemas/user.schema';
import {
  ORGANIZATION_ACCESS_DENIED,
  OrganizationsService,
} from '../organizations/organizations.service';
import {
  OrganizationCurrency,
  OrganizationRole,
  OrganizationStatus,
} from '../organizations/permissions';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import {
  ACCESS_SCOPE_CLAIM,
  AccessScope,
  RESTRICTED_TOKEN_TTL_SECONDS,
  SubscriptionAccessDecision,
  SubscriptionAccessView,
  subscriptionAccessLimitedException,
  subscriptionInactiveException,
  subscriptionStatusUnavailableException,
  toSubscriptionAccessView,
} from '../subscriptions/subscription-access';
import {
  EMAIL_NOT_VERIFIED,
  EMAIL_NOT_VERIFIED_MESSAGE,
  EmailVerificationService,
  type EmailVerificationDelivery,
} from '../email-verification/email-verification.service';
import {
  SESSION_REVOKED,
  SESSION_REVOKED_MESSAGE,
  SESSION_VERSION_CLAIM,
  currentSessionVersion,
} from './session-version';

export interface SelectableOrganization {
  organizationId: string;
  name: string;
}

export type LoginResult =
  | { access_token: string; user: Omit<UserDocument, 'password'> }
  | {
      organizationSelectionRequired: true;
      organizations: SelectableOrganization[];
    };

/**
 * Réponse minimale de l'onboarding propriétaire (1-6A) : aucun token,
 * aucun mot de passe/hash, aucun rôle legacy, aucune permission ni
 * identifiant de membership.
 */
export interface OwnerOnboardingResult {
  user: { _id: string; name: string; email: string };
  organization: {
    _id: string;
    name: string;
    slug: string;
    currency: OrganizationCurrency;
    status: OrganizationStatus;
  };
  /** 1-13A : compte créé NON vérifié ; résultat de l'envoi du lien. */
  emailVerification: { status: EmailVerificationDelivery };
}

// Session transactionnelle Mongoose (`mongodb.ClientSession`) : même
// convention que `products.service.ts`/`audit.service.ts`.
type MongooseSession = Awaited<ReturnType<Connection['startSession']>>;

/** Conflit stable existant (0B.5) : ne révèle pas l'existence du compte. */
const DUPLICATE_EMAIL_MESSAGE =
  'Si cette adresse est valide, un email de confirmation a déjà été envoyé.';

/** Erreur pilote MongoDB E11000 (clé dupliquée) — jamais un cast fragile. */
function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 11000
  );
}

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private organizationsService: OrganizationsService,
    @InjectConnection() private connection: Connection,
    private emailVerificationService: EmailVerificationService,
    private subscriptionsService: SubscriptionsService,
    private legalAcceptance: LegalAcceptanceService,
    private rateLimiter: PersistentRateLimiter,
    private turnstile: TurnstileService,
  ) {}

  /**
   * 1-13A : le lien de vérification part APRÈS le commit de l'onboarding.
   * Un échec d'envoi ne supprime ni ne vérifie le compte (statut `failed`,
   * renvoi possible via /auth/email-verification/request).
   */
  async register(dto: RegisterDto): Promise<OwnerOnboardingResult> {
    const result = await this.registerOwner(dto);
    const status = await this.emailVerificationService.issueForUser(
      result.user._id,
    );
    return { ...result, emailVerification: { status } };
  }

  /**
   * Onboarding atomique (1-6A) : User + Organization + Membership `owner`
   * dans UNE seule transaction (même session sur les trois écritures).
   * Le flag `PUBLIC_REGISTRATION_ENABLED` est vérifié par le contrôleur
   * AVANT cet appel (jamais de logique/écriture si désactivé).
   *
   * 1-16C.2 : acceptation des conditions d'utilisation ET d'abonnement
   * vérifiée AVANT toute écriture (case cochée, versions en vigueur,
   * langue publiée), puis preuve enregistrée dans la MÊME transaction :
   * sans preuve, ni compte ni commerce.
   */
  private async registerOwner(
    dto: RegisterDto,
  ): Promise<Omit<OwnerOnboardingResult, 'emailVerification'>> {
    const legal = this.legalAcceptance.resolveSubmission(
      LegalAcceptanceContext.OWNER_REGISTRATION,
      dto.legalAcceptance,
    );
    const hashed = await bcrypt.hash(dto.password, PASSWORD_HASH_ROUNDS);
    const session = await this.connection.startSession();
    let created:
      | {
          user: UserDocument;
          organization: OwnerOnboardingResult['organization'];
        }
      | undefined;

    try {
      await session.withTransaction(async () => {
        // 1-16G : langue du compte = langue des conditions acceptées.
        const user = await this.createOwnerUser(
          dto,
          hashed,
          session,
          legal.locale,
        );
        const { organization } =
          await this.organizationsService.createOwnerOrganization(
            dto.organizationName,
            user._id.toString(),
            session,
          );
        await this.legalAcceptance.record(session, {
          userId: user._id.toString(),
          organizationId: organization._id.toString(),
          submission: legal,
        });
        created = {
          user,
          organization: {
            _id: organization._id.toString(),
            name: organization.name,
            slug: organization.slug,
            currency: organization.currency,
            status: organization.status,
          },
        };
      });
    } finally {
      // Session fermée dans TOUS les cas (succès ou erreur) — pas de fuite.
      await session.endSession();
    }

    if (!created) {
      throw new Error(
        'Owner onboarding transaction completed without creating an owner',
      );
    }

    return {
      user: {
        _id: created.user._id.toString(),
        name: created.user.name,
        email: created.user.email,
      },
      organization: created.organization,
    };
  }

  /**
   * Rôle `User.role` legacy : `admin` (historique — jamais exposé dans la
   * réponse). L'autorité effective vient désormais de la membership
   * `owner` (1-1A/1-7+). Email dupliqué (E11000) → conflit stable
   * existant, sans donnée partielle (rollback de la transaction entière).
   */
  private async createOwnerUser(
    dto: RegisterDto,
    hashedPassword: string,
    session: MongooseSession,
    locale: string,
  ): Promise<UserDocument> {
    try {
      return await this.usersService.create(
        {
          name: dto.name,
          email: dto.email,
          password: hashedPassword,
          role: UserRole.ADMIN,
          ...(isAppLocale(locale) ? { locale } : {}),
        },
        session,
      );
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new BadRequestException(DUPLICATE_EMAIL_MESSAGE);
      }
      throw err;
    }
  }

  /**
   * Preuve d'identité commune au login et, en 1-18B, à l'acceptation d'une
   * invitation par identifiants : mêmes refus (401 générique, puis 403
   * `EMAIL_NOT_VERIFIED` seulement après un mot de passe correct). Ne
   * délivre aucun JWT et ne lit aucune organisation.
   *
   * 1-18C — Plafond PERSISTANT d'échecs par identifiant normalisé (fenêtre
   * fixe, partagée par les trois routes, toutes IP confondues, comptes
   * connus ou non) : une tentative est réservée AVANT la vérification
   * (atomique, aucune course ne dépasse le plafond), puis rendue si le mot
   * de passe est correct. Au-delà du plafond : même 429 que la limite par
   * IP, jusqu'à la fin de la fenêtre seulement. Compte inconnu : comparaison
   * à une empreinte factice de même coût (aucun délai artificiel).
   *
   * Récupération d'accès (plafond atteint) : un tiers ne peut pas imposer
   * l'attente au titulaire. Chaque essai exige alors un défi Turnstile NEUF
   * (action `login`, usage unique) ET reste plafonné par compte ET client
   * (IP ou /64) ; les limites par IP passent toujours avant. Un défi seul ne
   * remet rien à zéro : seule la combinaison défi réussi + bon mot de passe
   * ferme la fenêtre du compte. Sans Turnstile disponible, aucun défi n'est
   * proposé (refus temporaire jusqu'à la fin de la fenêtre).
   */
  async verifyCredentials(
    email: string,
    password: string,
    access: { challengeToken?: string; clientKey?: string } = {},
  ): Promise<UserDocument> {
    const { accountFailures, challengedFailures } = resolveAntiAbuseConfig();
    const subject = normalizeAccountEmail(email);
    const attempt = await this.rateLimiter.consume(accountFailures, subject);
    let challenged: Awaited<
      ReturnType<PersistentRateLimiter['consume']>
    > | null = null;
    if (!attempt.allowed) {
      if (!this.turnstile.isAvailable()) {
        throw new RateLimitedException(
          buildAuthRateLimitBody(),
          attempt.retryAfterSeconds,
        );
      }
      if (!access.challengeToken) {
        throw new RateLimitedException(
          buildAuthChallengeRequiredBody(),
          attempt.retryAfterSeconds,
        );
      }
      // Jeton refusé ou fournisseur indisponible : 400/503, rien consommé.
      await this.turnstile.verify(
        access.challengeToken,
        TURNSTILE_LOGIN_ACTION,
      );
      challenged = await this.rateLimiter.consume(
        challengedFailures,
        `${subject}\u0000${access.clientKey ?? 'unknown'}`,
      );
      if (!challenged.allowed) {
        throw new RateLimitedException(
          buildAuthRateLimitBody(),
          challenged.retryAfterSeconds,
        );
      }
    }

    const user = await this.usersService.findByEmail(email);
    const valid = await bcrypt.compare(
      password,
      user ? user.password : await dummyPasswordHash(),
    );
    if (!user || !valid)
      throw new UnauthorizedException('Email ou mot de passe incorrect!');
    if (challenged) {
      // Défi réussi ET bon mot de passe : le titulaire a prouvé son accès,
      // la fenêtre du compte est refermée (jamais sur un simple défi).
      await challenged.release();
      await this.rateLimiter.reset(accountFailures.scope, subject);
    } else {
      // Mot de passe correct : la tentative ne compte pas comme un échec.
      await attempt.release();
    }

    // 1-13A : identifiants corrects mais adresse non vérifiée → aucun JWT.
    // Vérifié APRÈS le mot de passe : ne révèle rien sans identifiants.
    if (!user.emailVerifiedAt) {
      throw new ForbiddenException({
        code: EMAIL_NOT_VERIFIED,
        message: EMAIL_NOT_VERIFIED_MESSAGE,
      });
    }
    return user;
  }

  async login(
    dto: LoginDto,
    access: { clientKey?: string } = {},
  ): Promise<LoginResult> {
    const user = await this.verifyCredentials(dto.email, dto.password, {
      challengeToken: dto.challengeToken,
      clientKey: access.clientKey,
    });

    const userId = user._id.toString();

    // Choix explicite : validation serveur complète (membership + org
    // actives), puis JWT. Tout refus est uniforme (jamais de détail).
    if (dto.organizationId) {
      const context = await this.organizationsService.resolveActiveContext(
        userId,
        dto.organizationId,
      );
      return this.loginForContext(user, context);
    }

    const organizations =
      await this.organizationsService.listActiveOrganizations(userId);

    // Aucune organisation active : même refus uniforme (l'organisation
    // ciblée par le login n'existe pas pour cet utilisateur).
    if (organizations.length === 0) {
      throw this.organizationAccessDenied();
    }

    if (organizations.length === 1) {
      // 1-14C.1 : contexte résolu (rôle réel requis pour `canRenew`) —
      // mêmes contrôles membership/organisation, refus uniforme inchangé.
      const context = await this.organizationsService.resolveActiveContext(
        userId,
        organizations[0].organizationId,
      );
      return this.loginForContext(user, context);
    }

    // Plusieurs organisations : le client doit choisir. Aucune donnée
    // sensible (permissions, membershipId), liste triée par nom
    // (ordre déterministe).
    return {
      organizationSelectionRequired: true,
      organizations: [...organizations].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    };
  }

  /**
   * Switch d'organisation : le `userId` provient EXCLUSIVEMENT de l'appelant
   * authentifié (sub du JWT) — jamais d'un corps de requête. Aucune
   * écriture persistante : seul le JWT (orgId) change.
   */
  async switchOrganization(
    userId: string,
    dto: SwitchOrganizationDto,
    sessionVersion: number,
    accessScope: AccessScope,
  ): Promise<{ access_token: string }> {
    // 1-14C.1 : un jeton limité ne change jamais d'organisation (seul
    // l'échange `subscription-access/complete` délivre un JWT applicatif).
    if (accessScope !== AccessScope.APP) {
      throw subscriptionAccessLimitedException();
    }
    const context = await this.organizationsService.resolveActiveContext(
      userId,
      dto.organizationId,
    );
    const decision = await this.readAccessDecision(context.organizationId);
    // 1-13B : le nouveau JWT hérite de la version VALIDÉE du JWT appelant,
    // jamais d'une version relue plus récente. Contrôle APRÈS toutes les
    // lectures : une réinitialisation survenue pendant la requête est
    // détectée ici (refus) ; si elle survient après, le JWT émis porte
    // l'ancienne version et sera refusé.
    await this.assertSessionVersion(userId, sessionVersion);
    if (!decision.active) {
      throw this.inactiveWithRestrictedToken(context, decision, sessionVersion);
    }
    return {
      access_token: this.sign(userId, context.organizationId, sessionVersion),
    };
  }

  /**
   * 1-14C.1 — échange d'un jeton LIMITÉ contre un JWT applicatif, une fois
   * l'abonnement actif. Revalidés : compte, email et version de session
   * (`JwtStrategy`), membership et organisation (`OrganizationGuard`, cette
   * requête), abonnement actif (relu ici), puis version de session APRÈS
   * toutes les lectures. Signé avec la version VALIDÉE du jeton limité,
   * jamais une version relue. Aucune donnée du body.
   */
  async completeSubscriptionAccess(
    principal: {
      _id: { toString(): string };
      sessionVersion: number;
      accessScope: AccessScope;
    },
    context: ResolvedOrganizationContext,
  ): Promise<{ access_token: string }> {
    if (principal.accessScope !== AccessScope.SUBSCRIPTION_LIMITED) {
      throw new BadRequestException({
        code: 'RESTRICTED_TOKEN_REQUIRED',
        message: 'Cet échange exige une session limitée.',
      });
    }
    const userId = principal._id.toString();
    const decision = await this.readAccessDecision(context.organizationId);
    await this.assertSessionVersion(userId, principal.sessionVersion);
    if (!decision.active) {
      throw subscriptionInactiveException({
        access: this.accessView(
          decision,
          context,
          AccessScope.SUBSCRIPTION_LIMITED,
        ),
      });
    }
    return {
      access_token: this.sign(
        userId,
        context.organizationId,
        principal.sessionVersion,
      ),
    };
  }

  /** 1-14C.1 — projection d'accès de l'organisation courante. */
  async accessViewFor(
    context: ResolvedOrganizationContext,
    scope: AccessScope,
  ): Promise<SubscriptionAccessView> {
    const decision = await this.readAccessDecision(context.organizationId);
    return this.accessView(decision, context, scope);
  }

  /**
   * Connexion pour un contexte VALIDÉ : abonnement actif → contrat
   * habituel ; sinon 403 `SUBSCRIPTION_INACTIVE` avec un jeton limité,
   * jamais de JWT applicatif. Version lue avec les identifiants (1-13B).
   */
  private async loginForContext(
    user: UserDocument,
    context: ResolvedOrganizationContext,
  ): Promise<LoginResult> {
    const version = currentSessionVersion(user);
    const decision = await this.readAccessDecision(context.organizationId);
    if (!decision.active) {
      throw this.inactiveWithRestrictedToken(context, decision, version);
    }
    return {
      access_token: this.sign(context.userId, context.organizationId, version),
      user: this.sanitize(user),
    };
  }

  private inactiveWithRestrictedToken(
    context: ResolvedOrganizationContext,
    decision: SubscriptionAccessDecision,
    sessionVersion: number,
  ) {
    return subscriptionInactiveException({
      restrictedToken: this.jwtService.sign(
        {
          sub: context.userId,
          orgId: context.organizationId,
          [SESSION_VERSION_CLAIM]: sessionVersion,
          [ACCESS_SCOPE_CLAIM]: AccessScope.SUBSCRIPTION_LIMITED,
        },
        { expiresIn: RESTRICTED_TOKEN_TTL_SECONDS },
      ),
      access: this.accessView(
        decision,
        context,
        AccessScope.SUBSCRIPTION_LIMITED,
      ),
    });
  }

  private accessView(
    decision: SubscriptionAccessDecision,
    context: ResolvedOrganizationContext,
    scope: AccessScope,
  ): SubscriptionAccessView {
    return toSubscriptionAccessView(decision, {
      isOwner: context.role === OrganizationRole.OWNER,
      scope,
    });
  }

  /** Échec technique de lecture → 503 contrôlé, jamais une « expiration ». */
  private async readAccessDecision(
    organizationId: string,
  ): Promise<SubscriptionAccessDecision> {
    try {
      return await this.subscriptionsService.getAccessDecision(organizationId);
    } catch {
      throw subscriptionStatusUnavailableException();
    }
  }

  private async assertSessionVersion(
    userId: string,
    sessionVersion: number,
  ): Promise<void> {
    const user = await this.usersService.findByIdForAuth(userId);
    if (!user || currentSessionVersion(user) !== sessionVersion) {
      throw new UnauthorizedException({
        code: SESSION_REVOKED,
        message: SESSION_REVOKED_MESSAGE,
      });
    }
  }

  private sign(
    userId: string,
    organizationId: string,
    sessionVersion: number,
  ): string {
    // Payload métier minimal : plus d'`email` ni de `role` — le rôle
    // vient exclusivement du document User chargé par la stratégie.
    // 1-13B : `ver` = version de session lue avec les identifiants (login)
    // ou validée dans le JWT appelant (switch).
    // 1-14C.1 : portée applicative EXPLICITE (claim signé).
    return this.jwtService.sign({
      sub: userId,
      orgId: organizationId,
      [SESSION_VERSION_CLAIM]: sessionVersion,
      [ACCESS_SCOPE_CLAIM]: AccessScope.APP,
    });
  }

  // Refus uniforme : ne révèle ni l'existence, ni le statut (suspension/
  // révocation) d'une organisation ou d'une membership.
  private organizationAccessDenied(): ForbiddenException {
    return new ForbiddenException({
      code: ORGANIZATION_ACCESS_DENIED,
      message: "Accès à l'organisation refusé.",
    });
  }

  private sanitize(user: UserDocument): Omit<UserDocument, 'password'> {
    const obj = user.toObject();
    // 1-13B : ni mot de passe ni version de session dans la réponse.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password: _p, authVersion: _v, ...rest } = obj;
    return rest as Omit<UserDocument, 'password'>;
  }
}
