import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { randomBytes, createHash } from 'crypto';
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
  DelegablePermission,
  InvitationStatus,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
} from './permissions';
import { UsersService } from '../users/users.service';
import { UserRole } from '../users/schemas/user.schema';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { AcceptInvitationDto } from '../auth/dto/accept-invitation.dto';
import * as bcrypt from 'bcryptjs';

// Session transactionnelle Mongoose (`mongodb.ClientSession`) : même
// convention que `products.service.ts`/`audit.service.ts`.
type MongooseSession = Awaited<ReturnType<Connection['startSession']>>;

/**
 * Slug serveur : jamais fourni par le client (1-6A). Dérivé du nom
 * (diacritiques retirés, minuscules, `[0-9a-z-]` uniquement, tronqué) +
 * suffixe aléatoire SÛR (`crypto.randomBytes`, pas `Math.random`) pour
 * l'unicité — total borné à 80 caractères (contrainte du schéma).
 */
export function generateOrganizationSlug(name: string): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^0-9a-z]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'org';
  const suffix = randomBytes(4).toString('hex');
  return `${base}-${suffix}`.slice(0, 80);
}

/**
 * ObjectId canonique : une CHAÎNE strictement de 24 caractères hexadécimaux.
 * Refuse nombre/objet/tableau, chaîne vide, chaîne de 12 caractères ou 24
 * caractères contenant un non-hex. `isValidObjectId()` n'est PAS utilisé :
 * son cast est trop permissif (plusieurs formes non-canoniques acceptées),
 * ce qui créerait un `CastError` 500 si un cast Mongoose raté se produisait.
 */
function isStrictObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value);
}

export interface ResolvedOrganizationContext {
  userId: string;
  organizationId: string;
  membershipId: string;
  role: OrganizationRole;
  permissions: DelegablePermission[];
}

/**
 * Vue minimale d'une organisation accessible (jamais de permissions,
 * d'identifiant de membership ou d'autre donnée sensible).
 */
export interface SelectableOrganization {
  organizationId: string;
  name: string;
}

export const ORGANIZATION_ACCESS_DENIED = 'ORGANIZATION_ACCESS_DENIED';

/** Erreur pilote MongoDB E11000 (clé dupliquée) — jamais un cast fragile. */
function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 11000
  );
}

/** Durée de vie d'une invitation (1-6B.1) : 72 h, calculée serveur. */
const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Vue publique d'une invitation : jamais `tokenHash`/`invitedById`
 * (`select: false` sur le schéma protège déjà `tokenHash` en base).
 */
export interface InvitationView {
  _id: string;
  email: string;
  role: OrganizationRole;
  permissions: DelegablePermission[];
  status: InvitationStatus;
  expiresAt: Date;
}

/** Réponse minimale de l'acceptation (1-6B.2) : jamais de JWT/token/hash. */
export interface InvitationAcceptanceResult {
  user: { _id: string; name: string; email: string };
  organization: { _id: string; name: string; slug: string };
  membership: { role: OrganizationRole; status: MembershipStatus };
}

/** Code stable et générique : ne révèle jamais LA raison exacte du refus. */
export const INVITATION_INVALID_OR_EXPIRED = 'INVITATION_INVALID_OR_EXPIRED';

@Injectable()
export class OrganizationsService {
  constructor(
    @InjectModel(Organization.name)
    private organizationModel: Model<OrganizationDocument>,
    @InjectModel(OrganizationMembership.name)
    private membershipModel: Model<OrganizationMembershipDocument>,
    @InjectModel(OrganizationInvitation.name)
    private invitationModel: Model<OrganizationInvitationDocument>,
    private usersService: UsersService,
    @InjectConnection() private connection: Connection,
  ) {}

  /**
   * Vérifie que l'utilisateur possède une membership active dans une
   * organisation active, et retourne un contexte minimal en lecture seule
   * (jamais de document Mongoose). L'organisation est résolue depuis la
   * membership, jamais depuis un identifiant client.
   */
  async resolveActiveContext(
    userId: string,
    organizationId: string,
  ): Promise<ResolvedOrganizationContext> {
    // STRICT : string + 24 hex (jamais de cast) — sinon refus uniforme,
    // AVANT toute requête DB.
    if (!isStrictObjectId(userId) || !isStrictObjectId(organizationId)) {
      throw this.accessDenied();
    }

    const membership = await this.membershipModel
      .findOne({
        userId: new Types.ObjectId(userId),
        organizationId: new Types.ObjectId(organizationId),
      })
      .exec();

    if (!membership || membership.status !== MembershipStatus.ACTIVE) {
      throw this.accessDenied();
    }

    const organization = await this.organizationModel
      .findById(membership.organizationId)
      .exec();

    if (!organization || organization.status !== OrganizationStatus.ACTIVE) {
      throw this.accessDenied();
    }

    return {
      userId,
      organizationId: organization._id.toString(),
      membershipId: membership._id.toString(),
      role: membership.role,
      permissions: [...membership.permissions],
    };
  }

  /**
   * Organisations ACTIVES accessibles à l'utilisateur : memberships actives
   * puis organisations actives uniquement. Ordre déterministe (tri par
   * `name` au retour). Aucune donnée sensible, aucun cache.
   */
  async listActiveOrganizations(
    userId: string,
  ): Promise<SelectableOrganization[]> {
    // STRICT : string + 24 hex (jamais de cast) — sinon liste vide,
    // AVANT toute requête DB.
    if (!isStrictObjectId(userId)) {
      return [];
    }

    const memberships = await this.membershipModel
      .find({
        userId: new Types.ObjectId(userId),
        status: MembershipStatus.ACTIVE,
      })
      .exec();

    const accessible: SelectableOrganization[] = [];
    for (const membership of memberships) {
      const organization = await this.organizationModel
        .findById(membership.organizationId)
        .exec();
      if (organization && organization.status === OrganizationStatus.ACTIVE) {
        accessible.push({
          organizationId: organization._id.toString(),
          name: organization.name,
        });
      }
    }
    // Tri déterministe : critère principal `name`, puis `organizationId`
    // (ordre lexicographique hex). Ne dépend ni de l'ordre naturel MongoDB
    // ni de la seule stabilité du tri JavaScript.
    return accessible.sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return a.organizationId.localeCompare(b.organizationId);
    });
  }

  /**
   * Onboarding atomique (1-6A) : crée l'Organization (branding/devise du
   * SCHÉMA, jamais du client) puis sa membership `owner` active
   * (`permissions: []`, `invitedById: null`), MÊME session que l'appelant
   * (transaction du registre). Slug généré serveur, jamais fourni.
   */
  async createOwnerOrganization(
    name: string,
    ownerId: string,
    session: MongooseSession,
  ): Promise<{
    organization: OrganizationDocument;
    membership: OrganizationMembershipDocument;
  }> {
    const [organization] = await this.organizationModel.create(
      [{ name, slug: generateOrganizationSlug(name) }],
      { session },
    );
    const [membership] = await this.membershipModel.create(
      [
        {
          organizationId: organization._id,
          userId: new Types.ObjectId(ownerId),
          role: OrganizationRole.OWNER,
          permissions: [],
          invitedById: null,
        },
      ],
      { session },
    );

    // Garde défensive : l'index unique partiel garantit au plus un owner
    // actif, jamais son existence — cette organisation vient d'être créée,
    // donc exactement 1 est l'unique résultat correct.
    const activeOwners = await this.membershipModel.countDocuments(
      {
        organizationId: organization._id,
        role: OrganizationRole.OWNER,
        status: MembershipStatus.ACTIVE,
      },
      { session },
    );
    if (activeOwners !== 1) {
      throw new Error(
        'Owner onboarding invariant violated: expected exactly one active owner.',
      );
    }

    return { organization, membership };
  }

  /**
   * Émission d'une invitation (1-6B.1, owner uniquement — vérifié par
   * l'appelant). `now` est un paramètre pour une horloge testable (défaut :
   * horloge réelle) — les 72h d'expiration sont calculées ici, jamais au
   * client. Refuse : email déjà membre actif de CETTE org, ou invitation
   * `pending` déjà émise (une invitation `pending` expirée est d'abord
   * marquée `expired`, elle ne bloque plus une réémission).
   */
  async createInvitation(
    organizationId: string,
    invitedById: string,
    dto: CreateInvitationDto,
    now: Date = new Date(),
  ): Promise<{ invitation: InvitationView; token: string }> {
    const email = dto.email.trim().toLowerCase();
    const orgOid = new Types.ObjectId(organizationId);

    const existingUser = await this.usersService.findByEmail(email);
    if (existingUser) {
      const activeMembership = await this.membershipModel
        .findOne({
          organizationId: orgOid,
          userId: existingUser._id,
          status: MembershipStatus.ACTIVE,
        })
        .exec();
      if (activeMembership) {
        throw new ConflictException({
          code: 'MEMBER_ALREADY_ACTIVE',
          message:
            'Cet email appartient déjà à un membre actif de cette organisation.',
        });
      }
    }

    const pending = await this.invitationModel
      .findOne({
        organizationId: orgOid,
        email,
        status: InvitationStatus.PENDING,
      })
      .exec();
    if (pending) {
      if (pending.expiresAt > now) {
        throw new ConflictException({
          code: 'INVITATION_ALREADY_PENDING',
          message: 'Une invitation est déjà en attente pour cet email.',
        });
      }
      // Expirée : on la clôture AVANT d'émettre la nouvelle — jamais 2 `pending`.
      pending.status = InvitationStatus.EXPIRED;
      await pending.save();
    }

    // Token brut renvoyé UNE SEULE fois ; seul le hash SHA-256 est stocké.
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    let invitation: OrganizationInvitationDocument;
    try {
      invitation = await this.invitationModel.create({
        organizationId: orgOid,
        email,
        role: dto.role,
        permissions: dto.permissions ?? [],
        tokenHash,
        invitedById: new Types.ObjectId(invitedById),
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      });
    } catch (err) {
      // Course concurrente sur l'index unique partiel (2 émissions en même
      // temps pour le même (org,email)) : même conflit stable que le
      // pré-check ci-dessus, jamais un 500.
      if (isDuplicateKeyError(err)) {
        throw new ConflictException({
          code: 'INVITATION_ALREADY_PENDING',
          message: 'Une invitation est déjà en attente pour cet email.',
        });
      }
      throw err;
    }

    return { invitation: this.toInvitationView(invitation), token: rawToken };
  }

  /** Invitations de l'organisation courante uniquement, jamais `tokenHash`. */
  async listInvitations(organizationId: string): Promise<InvitationView[]> {
    const invitations = await this.invitationModel
      .find({ organizationId: new Types.ObjectId(organizationId) })
      .sort({ createdAt: -1 })
      .exec();
    return invitations.map((invitation) => this.toInvitationView(invitation));
  }

  /**
   * Révocation : filtre `{ _id, organizationId, status: pending }` — une
   * invitation étrangère, absente, ou déjà acceptée/révoquée/expirée reçoit
   * le MÊME 404 (n'en révèle jamais l'existence/statut).
   */
  async revokeInvitation(
    organizationId: string,
    id: string,
  ): Promise<InvitationView> {
    const invitation = await this.invitationModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(id),
          organizationId: new Types.ObjectId(organizationId),
          status: InvitationStatus.PENDING,
        },
        { status: InvitationStatus.REVOKED },
        { new: true },
      )
      .exec();
    if (!invitation) {
      throw new NotFoundException();
    }
    return this.toInvitationView(invitation);
  }

  /**
   * Acceptation atomique (1-6B.2) : réclame l'invitation par un filtre
   * CONDITIONNEL (`pending` + `expiresAt > now`, une seule écriture
   * atomique — la garde anti-concurrence), crée le User SI absent (rôle
   * legacy `seller` — JAMAIS `admin`, même pour une invitation
   * `role: admin` : l'autorité effective vient de la membership, 1-7+),
   * puis la Membership (`role`/`permissions`/`organizationId`/
   * `invitedById` EXCLUSIVEMENT copiés de l'invitation). Toute erreur
   * abandonne TOUTE la transaction (l'invitation redevient `pending`).
   * Erreur générique et STABLE (`INVITATION_INVALID_OR_EXPIRED`) pour toute
   * invitation invalide (inconnue/expirée/revoked/accepted) ET pour une
   * organisation absente/suspendue : ne révèle jamais laquelle.
   */
  async acceptInvitation(
    dto: AcceptInvitationDto,
    now: Date = new Date(),
  ): Promise<InvitationAcceptanceResult> {
    const tokenHash = createHash('sha256').update(dto.token).digest('hex');
    const session = await this.connection.startSession();
    let result: InvitationAcceptanceResult | undefined;

    try {
      await session.withTransaction(async () => {
        const invitation = await this.invitationModel
          .findOneAndUpdate(
            {
              tokenHash,
              status: InvitationStatus.PENDING,
              expiresAt: { $gt: now },
            },
            { status: InvitationStatus.ACCEPTED, acceptedAt: now },
            { session, new: true },
          )
          .exec();
        if (!invitation) {
          throw this.invitationInvalidOrExpired();
        }

        const organization = await this.organizationModel
          .findById(invitation.organizationId)
          .session(session)
          .exec();
        if (
          !organization ||
          organization.status !== OrganizationStatus.ACTIVE
        ) {
          throw this.invitationInvalidOrExpired();
        }

        let user = await this.usersService.findByEmail(
          invitation.email,
          session,
        );
        if (!user) {
          if (!dto.name || !dto.password) {
            throw new BadRequestException({
              code: 'ACCOUNT_DETAILS_REQUIRED',
              message: 'name et password sont requis pour créer un compte.',
            });
          }
          const hashed = await bcrypt.hash(dto.password, 10);
          user = await this.usersService.create(
            {
              name: dto.name,
              email: invitation.email,
              password: hashed,
              role: UserRole.SELLER,
            },
            session,
          );
        }

        // Membre déjà présent (même suspendu/révoqué) : refus stable,
        // AUCUNE réactivation silencieuse.
        const existingMembership = await this.membershipModel
          .findOne({
            organizationId: invitation.organizationId,
            userId: user._id,
          })
          .session(session)
          .exec();
        if (existingMembership) {
          throw new ConflictException({
            code: 'MEMBERSHIP_ALREADY_EXISTS',
            message: 'Ce compte appartient déjà à cette organisation.',
          });
        }

        const [membership] = await this.membershipModel.create(
          [
            {
              organizationId: invitation.organizationId,
              userId: user._id,
              role: invitation.role,
              permissions: [...invitation.permissions],
              invitedById: invitation.invitedById,
            },
          ],
          { session },
        );

        // Garde défensive finale (même esprit que `createOwnerOrganization`) :
        // l'index unique `{organizationId,userId}` garantit au plus une
        // membership, cette vérification prouve qu'elle existe bien.
        const memberships = await this.membershipModel.countDocuments(
          { organizationId: invitation.organizationId, userId: user._id },
          { session },
        );
        if (memberships !== 1) {
          throw new Error(
            'Invitation acceptance invariant violated: expected exactly one membership.',
          );
        }

        result = {
          user: {
            _id: user._id.toString(),
            name: user.name,
            email: user.email,
          },
          organization: {
            _id: organization._id.toString(),
            name: organization.name,
            slug: organization.slug,
          },
          membership: { role: membership.role, status: membership.status },
        };
      });
    } finally {
      // Session fermée dans TOUS les cas (succès ou erreur) — pas de fuite.
      await session.endSession();
    }

    if (!result) {
      throw new Error(
        'Invitation acceptance transaction completed without a result',
      );
    }
    return result;
  }

  private invitationInvalidOrExpired(): BadRequestException {
    return new BadRequestException({
      code: INVITATION_INVALID_OR_EXPIRED,
      message: 'Cette invitation est invalide ou a expiré.',
    });
  }

  private toInvitationView(
    invitation: OrganizationInvitationDocument,
  ): InvitationView {
    return {
      _id: invitation._id.toString(),
      email: invitation.email,
      role: invitation.role,
      permissions: [...invitation.permissions],
      status: invitation.status,
      expiresAt: invitation.expiresAt,
    };
  }

  private accessDenied(): ForbiddenException {
    // Message volontairement uniforme : ne révèle ni l'existence, ni le
    // statut (suspension/révocation) d'une organisation ou d'une membership.
    return new ForbiddenException({
      code: ORGANIZATION_ACCESS_DENIED,
      message: "Accès à l'organisation refusé.",
    });
  }
}
