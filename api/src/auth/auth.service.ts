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
import { UsersService } from '../users/users.service';
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
  OrganizationStatus,
} from '../organizations/permissions';

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
  ) {}

  register(dto: RegisterDto): Promise<OwnerOnboardingResult> {
    return this.registerOwner(dto);
  }

  /**
   * Onboarding atomique (1-6A) : User + Organization + Membership `owner`
   * dans UNE seule transaction (même session sur les trois écritures).
   * Le flag `PUBLIC_REGISTRATION_ENABLED` est vérifié par le contrôleur
   * AVANT cet appel (jamais de logique/écriture si désactivé).
   */
  private async registerOwner(
    dto: RegisterDto,
  ): Promise<OwnerOnboardingResult> {
    const hashed = await bcrypt.hash(dto.password, 10);
    const session = await this.connection.startSession();
    let created:
      | {
          user: UserDocument;
          organization: OwnerOnboardingResult['organization'];
        }
      | undefined;

    try {
      await session.withTransaction(async () => {
        const user = await this.createOwnerUser(dto, hashed, session);
        const { organization } =
          await this.organizationsService.createOwnerOrganization(
            dto.organizationName,
            user._id.toString(),
            session,
          );
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
  ): Promise<UserDocument> {
    try {
      return await this.usersService.create(
        {
          name: dto.name,
          email: dto.email,
          password: hashedPassword,
          role: UserRole.ADMIN,
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

  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user)
      throw new UnauthorizedException('Email ou mot de passe incorrect!');

    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid)
      throw new UnauthorizedException('Email ou mot de passe incorrect!');

    const userId = user._id.toString();

    // Choix explicite : validation serveur complète (membership + org
    // actives), puis JWT. Tout refus est uniforme (jamais de détail).
    if (dto.organizationId) {
      const context = await this.organizationsService.resolveActiveContext(
        userId,
        dto.organizationId,
      );
      return {
        access_token: this.sign(userId, context.organizationId),
        user: this.sanitize(user),
      };
    }

    const organizations =
      await this.organizationsService.listActiveOrganizations(userId);

    // Aucune organisation active : même refus uniforme (l'organisation
    // ciblée par le login n'existe pas pour cet utilisateur).
    if (organizations.length === 0) {
      throw this.organizationAccessDenied();
    }

    if (organizations.length === 1) {
      return {
        access_token: this.sign(userId, organizations[0].organizationId),
        user: this.sanitize(user),
      };
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
  ): Promise<{ access_token: string }> {
    const context = await this.organizationsService.resolveActiveContext(
      userId,
      dto.organizationId,
    );
    return { access_token: this.sign(userId, context.organizationId) };
  }

  private sign(userId: string, organizationId: string): string {
    // Payload métier minimal : plus d'`email` ni de `role` — le rôle
    // vient exclusivement du document User chargé par la stratégie.
    return this.jwtService.sign({ sub: userId, orgId: organizationId });
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password: _p, ...rest } = obj;
    return rest as Omit<UserDocument, 'password'>;
  }
}
