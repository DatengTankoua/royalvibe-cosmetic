import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { createHash, randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import {
  Organization,
  OrganizationDocument,
} from './schemas/organization.schema';
import {
  OrganizationMembership,
  OrganizationMembershipDocument,
} from './schemas/membership.schema';
import {
  OrganizationInvitation,
  OrganizationInvitationDocument,
} from './schemas/invitation.schema';
import {
  InvitationStatus,
  OrganizationRole,
  OrganizationStatus,
} from './permissions';
import {
  INVITATION_INVALID_OR_EXPIRED,
  type InvitationAcceptanceResult,
} from './organizations.service';
import { SocketRegistryService } from './socket-registry.service';
import {
  buildInvitationAccountUrl,
  parsePublicAppOrigin,
} from './invitation-link';
import { buildInvitationAccountEmail } from './invitation-account-email';
import { PersistentRateLimiter } from '../common/rate-limit/persistent-rate-limiter.service';
import { resolveAntiAbuseConfig } from '../common/rate-limit/anti-abuse-config';
import { UsersService } from '../users/users.service';
import { UserRole, type UserDocument } from '../users/schemas/user.schema';
import { LegalAcceptanceService } from '../legal/legal-acceptance.service';
import { LegalAcceptanceContext } from '../legal/legal-documents';
import { isAppLocale, type AppLocale } from '../common/i18n/locale';
import {
  EMAIL_SENDER,
  EmailDeliveryError,
  type EmailSender,
} from '../email-verification/email-sender';
import { EMAIL_DELIVERY_UNAVAILABLE } from '../email-verification/email-verification.service';
import type {
  AcceptInvitationDto,
  CreateInvitationAccountDto,
} from '../auth/dto/accept-invitation.dto';
import { PushOutboxService } from '../push/push-outbox.service';

/** Invitation valide, mais destinée à une autre adresse que la session. */
export const INVITATION_ACCOUNT_MISMATCH = 'INVITATION_ACCOUNT_MISMATCH';
/** Lien de création ouvert alors qu'un compte existe déjà pour l'adresse. */
export const INVITATION_ACCOUNT_EXISTS = 'INVITATION_ACCOUNT_EXISTS';

/** Validité maximale du lien de création (bornée par celle de l'invitation). */
export const INVITATION_ACCOUNT_LINK_TTL_MS = 24 * 60 * 60 * 1000;
/** Délai minimal entre deux envois pour une même invitation. */
export const INVITATION_ACCOUNT_LINK_COOLDOWN_MS = 60 * 1000;
/** Plafond d'envois par invitation, sur toute sa durée de vie. */
export const INVITATION_ACCOUNT_LINK_MAX_SENDS = 5;

export const INVITATION_ACCOUNT_LINK_ACCEPTED_MESSAGE =
  "Si l'adresse invitée n'a pas encore de compte, un lien pour le créer vient d'y être envoyé.";

type MongooseSession = Awaited<ReturnType<Connection['startSession']>>;

/** Identité vérifiée de la session (JWT validé par `JwtStrategy`). */
export interface InvitationPrincipal {
  _id: { toString(): string };
  email: string;
}

export interface InvitationPreview {
  organization: { name: string };
  role: OrganizationRole;
}

export type ExistingAccountAcceptance = Omit<
  InvitationAcceptanceResult,
  'user'
>;

export interface CreatedInvitationAccount {
  user: { email: string };
  organization: { name: string };
}

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 11000
  );
}

interface AccountLinkClaim {
  email: string;
  organizationName: string;
  rawToken: string;
  idempotencyKey: string;
}

/**
 * 1-18B — Acceptation des invitations.
 *
 * Le lien d'invitation est remis au CRÉATEUR : il ne prouve ni l'identité de
 * son détenteur ni le contrôle de l'adresse invitée. Donc :
 * - compte existant : rattaché seulement par une session de CE compte
 *   (adresse identique) et un accord explicite ;
 * - nouveau compte : créé seulement depuis un second lien, envoyé à
 *   l'adresse invitée. Le nom et le mot de passe sont choisis après
 *   l'ouverture de ce lien ; l'adresse est alors vérifiée.
 * Aucune réponse sans session ne dépend de l'existence d'un compte.
 * Expiration, révocation, usage unique, transaction et isolation sont
 * conservés (filtres conditionnels `pending` + `expiresAt`).
 *
 * 1-19A — L'acceptation SUPPRIME l'invitation (`findOneAndDelete`
 * conditionnel) dans la transaction qui crée la membership : les deux liens
 * (créateur et création de compte) ne désignent plus rien ensuite, et tout
 * refus ou échec annule la suppression (invitation intacte). L'événement
 * `member-joined` est enregistré dans la même transaction ; il ne dépend
 * pas de l'invitation supprimée (membership et utilisateur seulement).
 */
@Injectable()
export class InvitationAcceptanceService {
  private readonly logger = new Logger('InvitationAcceptance');

  constructor(
    @InjectModel(Organization.name)
    private readonly organizationModel: Model<OrganizationDocument>,
    @InjectModel(OrganizationMembership.name)
    private readonly membershipModel: Model<OrganizationMembershipDocument>,
    @InjectModel(OrganizationInvitation.name)
    private readonly invitationModel: Model<OrganizationInvitationDocument>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    private readonly usersService: UsersService,
    private readonly legalAcceptance: LegalAcceptanceService,
    private readonly socketRegistry: SocketRegistryService,
    private readonly config: ConfigService,
    private readonly rateLimiter: PersistentRateLimiter,
    private readonly pushOutbox: PushOutboxService,
  ) {}

  // ─── Compte existant (session requise) ────────────────────────────────

  /**
   * Aperçu pour la session : organisation et rôle, seulement si
   * l'invitation est utilisable ET destinée à l'adresse de la session.
   * Aucune écriture.
   */
  async inspect(
    token: string,
    principal: InvitationPrincipal,
    now: Date = new Date(),
  ): Promise<InvitationPreview> {
    const invitation = await this.usableInvitation(hashToken(token), now);
    if (!invitation) throw this.invalidOrExpired();
    const organization = await this.activeOrganization(
      invitation.organizationId,
    );
    if (!organization) throw this.invalidOrExpired();
    if (invitation.email !== normalizedEmail(principal.email)) {
      throw this.accountMismatch();
    }
    const membership = await this.membershipModel
      .findOne({
        organizationId: invitation.organizationId,
        userId: new Types.ObjectId(principal._id.toString()),
      })
      .exec();
    if (membership) throw this.alreadyMember();
    return { organization: { name: organization.name }, role: invitation.role };
  }

  /**
   * Rattachement du compte de la session, après accord explicite
   * (`consent: true`, imposé par le DTO). La réclamation de l'invitation
   * est conditionnée à l'adresse de la session : un autre compte ne la
   * consomme jamais. Tout refus annule la transaction (invitation intacte).
   */
  async acceptForAccount(
    dto: AcceptInvitationDto,
    principal: InvitationPrincipal,
    now: Date = new Date(),
  ): Promise<ExistingAccountAcceptance> {
    const tokenHash = hashToken(dto.token);
    const email = normalizedEmail(principal.email);
    const userId = new Types.ObjectId(principal._id.toString());
    const session = await this.connection.startSession();
    let result: ExistingAccountAcceptance | undefined;
    try {
      await session.withTransaction(async () => {
        // 1-19A : réclamation = suppression conditionnelle (usage unique).
        const invitation = await this.invitationModel
          .findOneAndDelete(
            { ...usableFilter(now), tokenHash, email },
            { session },
          )
          .exec();
        if (!invitation) {
          // Distinction APRÈS l'échec de la réclamation, sans écriture : une
          // invitation utilisable d'une autre adresse → mauvais compte.
          const other = await this.invitationModel
            .findOne({ ...usableFilter(now), tokenHash })
            .session(session)
            .exec();
          throw other ? this.accountMismatch() : this.invalidOrExpired();
        }
        const organization = await this.activeOrganization(
          invitation.organizationId,
          session,
        );
        if (!organization) throw this.invalidOrExpired();

        const membership = await this.createMembership(
          invitation,
          userId,
          session,
        );
        await this.recordJoined(invitation, userId, membership, session);
        result = {
          organization: {
            _id: organization._id.toString(),
            name: organization.name,
            slug: organization.slug,
          },
          membership: { role: membership.role, status: membership.status },
        };
      });
    } finally {
      await session.endSession();
    }
    if (!result) {
      throw new Error('Invitation acceptance completed without a result');
    }
    this.signalChanges(result.organization._id);
    return result;
  }

  // ─── Nouveau compte (lien envoyé à l'adresse invitée) ─────────────────

  /**
   * Demande publique du lien de création. Seuls une configuration d'envoi
   * absente (503) et une invitation inutilisable (400, indépendant de tout
   * compte) sont signalés. La recherche du compte, la réservation et l'envoi
   * ont lieu APRÈS la réponse : ni le contenu ni la durée de la réponse ne
   * dépendent de l'existence d'un compte. Compte existant → aucun envoi.
   */
  async requestAccountLink(
    token: string,
    locale: AppLocale,
    now: Date = new Date(),
  ): Promise<{ delivery: Promise<void> }> {
    if (this.appOrigin() === null || !this.sender.isConfigured()) {
      this.logger.warn('Invitation account link: delivery is not configured');
      throw new ServiceUnavailableException({
        code: EMAIL_DELIVERY_UNAVAILABLE,
        message:
          "L'envoi d'emails est momentanément indisponible. Réessayez plus tard.",
      });
    }
    const invitation = await this.usableInvitation(hashToken(token), now);
    if (!invitation) throw this.invalidOrExpired();
    const organization = await this.activeOrganization(
      invitation.organizationId,
    );
    if (!organization) throw this.invalidOrExpired();

    const delivery = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.claimAccountLink(invitation._id, organization.name, now))
      .then((claim) =>
        claim ? this.deliverAccountLink(claim, locale) : undefined,
      )
      .catch(() => {
        this.logger.warn('Invitation account link: request processing failed');
      });
    return { delivery };
  }

  /**
   * Création du compte depuis le lien reçu par e-mail : nom et mot de passe
   * choisis par la personne qui contrôle la boîte, adresse vérifiée à cet
   * instant (même preuve que la confirmation 1-13A : un jeton secret reçu à
   * cette adresse). Compte, membership, preuve légale et consommation de
   * l'invitation dans UNE transaction.
   */
  async createAccount(
    dto: CreateInvitationAccountDto,
    now: Date = new Date(),
  ): Promise<CreatedInvitationAccount> {
    const accountTokenHash = hashToken(dto.token);
    const linkFilter = {
      ...usableFilter(now),
      accountTokenHash,
      accountTokenExpiresAt: { $gt: now },
    };
    // Candidat vérifié AVANT le hachage coûteux et les contrôles légaux.
    const candidate = await this.invitationModel.findOne(linkFilter).exec();
    if (!candidate) throw this.invalidOrExpired();
    const legal = this.legalAcceptance.resolveSubmission(
      LegalAcceptanceContext.INVITATION_ACCOUNT,
      dto.legalAcceptance,
    );
    const hashed = await bcrypt.hash(dto.password, 10);

    const session = await this.connection.startSession();
    let result: CreatedInvitationAccount | undefined;
    let organizationId: string | undefined;
    try {
      await session.withTransaction(async () => {
        // 1-19A : réclamation = suppression conditionnelle (usage unique).
        const invitation = await this.invitationModel
          .findOneAndDelete({ ...linkFilter, _id: candidate._id }, { session })
          .exec();
        if (!invitation) throw this.invalidOrExpired();
        const organization = await this.activeOrganization(
          invitation.organizationId,
          session,
        );
        if (!organization) throw this.invalidOrExpired();

        // Seule la personne qui contrôle l'adresse lit ce refus.
        if (await this.usersService.findByEmail(invitation.email, session)) {
          throw this.accountExists();
        }
        let user: UserDocument;
        try {
          user = await this.usersService.create(
            {
              name: dto.name,
              email: invitation.email,
              password: hashed,
              role: UserRole.SELLER,
              emailVerifiedAt: now,
              ...(isAppLocale(legal.locale) ? { locale: legal.locale } : {}),
            },
            session,
          );
        } catch (err) {
          if (isDuplicateKeyError(err)) throw this.accountExists();
          throw err;
        }
        const membership = await this.createMembership(
          invitation,
          user._id,
          session,
        );
        await this.recordJoined(invitation, user._id, membership, session);
        await this.legalAcceptance.record(session, {
          userId: user._id.toString(),
          organizationId: invitation.organizationId.toString(),
          submission: legal,
        });
        organizationId = organization._id.toString();
        result = {
          user: { email: user.email },
          organization: { name: organization.name },
        };
      });
    } finally {
      await session.endSession();
    }
    if (!result || !organizationId) {
      throw new Error('Invitation account creation completed without a result');
    }
    this.signalChanges(organizationId);
    return result;
  }

  // ─── Interne ──────────────────────────────────────────────────────────

  private appOrigin(): string | null {
    return parsePublicAppOrigin(this.config.get<string>('PUBLIC_APP_URL'));
  }

  private usableInvitation(
    tokenHash: string,
    now: Date,
  ): Promise<OrganizationInvitationDocument | null> {
    return this.invitationModel
      .findOne({ ...usableFilter(now), tokenHash })
      .exec();
  }

  private activeOrganization(
    organizationId: Types.ObjectId,
    session?: MongooseSession,
  ): Promise<OrganizationDocument | null> {
    return this.organizationModel
      .findOne({ _id: organizationId, status: OrganizationStatus.ACTIVE })
      .session(session ?? null)
      .exec();
  }

  /**
   * Membership copiée EXCLUSIVEMENT de l'invitation (rôle, permissions,
   * organisation, auteur). Membre déjà présent (même suspendu/révoqué) :
   * refus stable, aucune réactivation silencieuse.
   */
  private async createMembership(
    invitation: OrganizationInvitationDocument,
    userId: Types.ObjectId,
    session: MongooseSession,
  ): Promise<OrganizationMembershipDocument> {
    const existing = await this.membershipModel
      .findOne({ organizationId: invitation.organizationId, userId })
      .session(session)
      .exec();
    if (existing) throw this.alreadyMember();
    const [membership] = await this.membershipModel.create(
      [
        {
          organizationId: invitation.organizationId,
          userId,
          role: invitation.role,
          permissions: [...invitation.permissions],
          invitedById: invitation.invitedById,
        },
      ],
      { session },
    );
    const count = await this.membershipModel.countDocuments(
      { organizationId: invitation.organizationId, userId },
      { session },
    );
    if (count !== 1) {
      throw new Error(
        'Invitation acceptance invariant violated: expected exactly one membership.',
      );
    }
    return membership;
  }

  /** 1-19A : adhésion annoncée, dans la transaction d'acceptation. */
  private async recordJoined(
    invitation: OrganizationInvitationDocument,
    userId: Types.ObjectId,
    membership: OrganizationMembershipDocument,
    session: MongooseSession,
  ): Promise<void> {
    await this.pushOutbox.memberJoinedInSession(session, {
      organizationId: invitation.organizationId,
      userId,
      membershipId: membership._id,
    });
  }

  /**
   * Réservation : aucun compte pour l'adresse, cooldown, plafond par
   * invitation, puis écriture conditionnée au dernier envoi lu (deux
   * demandes concurrentes → un seul envoi). Le nouveau lien remplace le
   * précédent.
   */
  private async claimAccountLink(
    invitationId: Types.ObjectId,
    organizationName: string,
    now: Date,
  ): Promise<AccountLinkClaim | null> {
    const invitation = await this.invitationModel
      .findOne({ ...usableFilter(now), _id: invitationId })
      .select('+accountLinkLastSentAt +accountLinkSendCount')
      .exec();
    if (!invitation) return null;
    if (await this.usersService.findByEmail(invitation.email)) return null;

    const lastSentAt = invitation.accountLinkLastSentAt;
    if (
      lastSentAt &&
      now.getTime() - lastSentAt.getTime() < INVITATION_ACCOUNT_LINK_COOLDOWN_MS
    ) {
      return null;
    }
    const sendCount = invitation.accountLinkSendCount ?? 0;
    if (sendCount >= INVITATION_ACCOUNT_LINK_MAX_SENDS) return null;

    // 1-18C — Plafond PAR DESTINATAIRE (adresse normalisée par le modèle),
    // toutes invitations et organisations confondues, réservé atomiquement
    // AVANT l'envoi : une nouvelle invitation ne le contourne pas. Plafond
    // atteint → aucun envoi, réponse publique toujours neutre.
    const recipient = await this.rateLimiter.consume(
      resolveAntiAbuseConfig().invitationEmailRecipient,
      invitation.email,
      now,
    );
    if (!recipient.allowed) {
      this.logger.warn('Invitation account link: recipient limit reached');
      return null;
    }

    const rawToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Math.min(
        invitation.expiresAt.getTime(),
        now.getTime() + INVITATION_ACCOUNT_LINK_TTL_MS,
      ),
    );
    const update = await this.invitationModel
      .updateOne(
        {
          ...usableFilter(now),
          _id: invitation._id,
          accountLinkLastSentAt: lastSentAt ?? { $exists: false },
        },
        {
          $set: {
            accountTokenHash: hashToken(rawToken),
            accountTokenExpiresAt: expiresAt,
            accountLinkLastSentAt: now,
            accountLinkSendCount: sendCount + 1,
          },
        },
      )
      .exec();
    if (update.modifiedCount !== 1) {
      // Envoi concurrent déjà réservé pour cette invitation : place rendue.
      await recipient.release();
      return null;
    }
    return {
      email: invitation.email,
      organizationName,
      rawToken,
      idempotencyKey: `invitation-account-${invitation._id.toString()}-${now.getTime()}`,
    };
  }

  /** Envoi unique (aucune relance) ; journal réduit à la raison. */
  private async deliverAccountLink(
    claim: AccountLinkClaim,
    locale: AppLocale,
  ): Promise<void> {
    const origin = this.appOrigin();
    if (!origin) {
      this.logger.warn('Invitation account link: delivery is not configured');
      return;
    }
    const content = buildInvitationAccountEmail(
      claim.organizationName,
      buildInvitationAccountUrl(origin, claim.rawToken),
      locale,
    );
    try {
      await this.sender.send({
        to: claim.email,
        ...content,
        idempotencyKey: claim.idempotencyKey,
      });
    } catch (err) {
      // Jamais d'adresse, de token, d'URL ni de réponse brute du fournisseur.
      const reason =
        err instanceof EmailDeliveryError
          ? `${err.reason}${err.providerStatus ? ` (HTTP ${err.providerStatus})` : ''}`
          : 'unexpected';
      this.logger.warn(`Invitation account link: delivery failed — ${reason}`);
    }
  }

  /** 1-15C : APRÈS le commit, signaux sans donnée. */
  private signalChanges(organizationId: string): void {
    this.socketRegistry.signalOrganization(
      organizationId,
      'invitations:changed',
    );
    this.socketRegistry.signalOrganization(organizationId, 'members:changed');
  }

  private invalidOrExpired(): BadRequestException {
    return new BadRequestException({
      code: INVITATION_INVALID_OR_EXPIRED,
      message: 'Cette invitation est invalide ou a expiré.',
    });
  }

  private accountMismatch(): ForbiddenException {
    return new ForbiddenException({
      code: INVITATION_ACCOUNT_MISMATCH,
      message:
        "Cette invitation est destinée à un autre compte. Connectez-vous avec l'adresse invitée.",
    });
  }

  private accountExists(): ConflictException {
    return new ConflictException({
      code: INVITATION_ACCOUNT_EXISTS,
      message:
        "Un compte existe déjà pour cette adresse. Connectez-vous, puis ouvrez de nouveau le lien d'invitation.",
    });
  }

  private alreadyMember(): ConflictException {
    return new ConflictException({
      code: 'MEMBERSHIP_ALREADY_EXISTS',
      message: 'Ce compte appartient déjà à cette organisation.',
    });
  }
}

/** Invitation utilisable : en attente et non expirée (jamais révoquée/acceptée). */
function usableFilter(now: Date) {
  return { status: InvitationStatus.PENDING, expiresAt: { $gt: now } };
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}
