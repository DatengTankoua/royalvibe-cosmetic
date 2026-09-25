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
  effectivePermissions,
  InvitationStatus,
  isPermissionSubset,
  MembershipStatus,
  OrganizationCurrency,
  OrganizationRole,
  OrganizationStatus,
  PERMISSION_DENIED_RESPONSE,
} from './permissions';
import { UsersService } from '../users/users.service';
import { UserRole } from '../users/schemas/user.schema';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { UpdateMembershipDto } from './dto/update-membership.dto';
import { UpdateBrandingDto } from './dto/update-branding.dto';
import { AcceptInvitationDto } from '../auth/dto/accept-invitation.dto';
import { SocketRegistryService } from './socket-registry.service';
import { S3Service } from '../s3/s3.service';
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

/** Vue minimale d'un membre (1-7C) : jamais `password`/`User.role`. */
export interface MemberView {
  membershipId: string;
  user: { _id: string; name: string; email: string };
  role: OrganizationRole;
  permissions: DelegablePermission[];
  status: MembershipStatus;
  joinedAt: Date;
}

/** Réponse du transfert de propriété (1-7C). */
export interface TransferOwnershipResult {
  previousOwner: MemberView;
  newOwner: MemberView;
}

/**
 * Vue `GET /organizations/current` (1-8A) : jamais `logoKey` (donnée de
 * stockage interne), `logoUrl` est DÉRIVÉE de `logoKey` (`null` sans logo).
 */
export interface OrganizationCurrentView {
  _id: string;
  name: string;
  slug: string;
  brandColor: string;
  currency: OrganizationCurrency;
  status: OrganizationStatus;
  logoUrl: string | null;
}

/** Résultat d'une mutation de branding (1-8A) : l'ancien `logoKey` permet au contrôleur de nettoyer S3 APRÈS ce commit. */
export interface BrandingMutationResult {
  organization: OrganizationCurrentView;
  previousLogoKey: string | null;
}

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
    private socketRegistry: SocketRegistryService,
    private s3Service: S3Service,
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

  /** Membres de l'organisation courante uniquement, jamais `password`/`User.role`. */
  async listMembers(organizationId: string): Promise<MemberView[]> {
    const memberships = await this.membershipModel
      .find({ organizationId: new Types.ObjectId(organizationId) })
      .populate('userId', 'name email')
      .sort({ joinedAt: 1 })
      .exec();
    return memberships.map((m) => this.toMemberView(m));
  }

  /**
   * Mutation d'une membership (1-7C) — `members.manage`. Filtre composite
   * `{_id, organizationId}` : cible étrangère/absente → même 404. Actor ET
   * cible sont RELUS dans la transaction (jamais le `organizationContext`
   * HTTP, potentiellement obsolète). Anti-escalade : un acteur non-owner ne
   * peut agir que sur un membre dont les permissions effectives ACTUELLES
   * sont incluses dans les siennes, et ne peut jamais produire un état
   * cible dont les permissions effectives PROSPECTIVES dépasseraient les
   * siennes. `owner` contourne cette borne (ses permissions effectives sont
   * déjà l'ensemble complet).
   */
  async updateMembership(
    organizationId: string,
    actorUserId: string,
    targetMembershipId: string,
    dto: UpdateMembershipDto,
  ): Promise<MemberView> {
    if (
      dto.role === undefined &&
      dto.permissions === undefined &&
      dto.status === undefined
    ) {
      throw new BadRequestException({
        code: 'EMPTY_MEMBERSHIP_UPDATE',
        message: 'Au moins un champ (role, permissions, status) est requis.',
      });
    }

    const orgOid = new Types.ObjectId(organizationId);
    const session = await this.connection.startSession();
    let result: MemberView | undefined;
    let targetUserId: string | undefined;

    try {
      await session.withTransaction(async () => {
        const target = await this.membershipModel
          .findOne({
            _id: new Types.ObjectId(targetMembershipId),
            organizationId: orgOid,
          })
          .populate('userId', 'name email')
          .session(session)
          .exec();
        if (!target) throw new NotFoundException();

        const targetUserIdStr = String(
          (target.userId as unknown as { _id?: Types.ObjectId })._id ??
            target.userId,
        );
        if (targetUserIdStr === actorUserId) {
          throw new ForbiddenException({
            code: 'SELF_MANAGEMENT_FORBIDDEN',
            message: 'Un membre ne peut pas modifier sa propre membership.',
          });
        }
        if (target.role === OrganizationRole.OWNER) {
          throw new ForbiddenException({
            code: 'OWNER_NOT_MANAGEABLE',
            message:
              'Le propriétaire ne peut pas être modifié par cette route.',
          });
        }

        // Relecture FRAÎCHE de l'acteur (jamais le contexte HTTP) : ses
        // droits effectifs peuvent avoir changé depuis la garde HTTP.
        const actor = await this.membershipModel
          .findOne({
            userId: new Types.ObjectId(actorUserId),
            organizationId: orgOid,
          })
          .session(session)
          .exec();
        if (!actor || actor.status !== MembershipStatus.ACTIVE) {
          throw this.accessDenied();
        }

        if (actor.role !== OrganizationRole.OWNER) {
          const actorEffective = effectivePermissions(
            actor.role,
            actor.permissions,
          );
          const targetCurrentEffective = effectivePermissions(
            target.role,
            target.permissions,
          );
          const prospectiveEffective = effectivePermissions(
            dto.role ?? target.role,
            dto.permissions ?? target.permissions,
          );
          if (
            !isPermissionSubset(targetCurrentEffective, actorEffective) ||
            !isPermissionSubset(prospectiveEffective, actorEffective)
          ) {
            throw new ForbiddenException(PERMISSION_DENIED_RESPONSE);
          }
        }

        if (dto.role !== undefined) target.role = dto.role;
        if (dto.permissions !== undefined) target.permissions = dto.permissions;
        // Aucune réactivation implicite : `status` n'est touché QUE si
        // explicitement demandé (jamais un effet de bord de role/permissions).
        if (dto.status !== undefined) target.status = dto.status;

        await target.save({ session });
        targetUserId = targetUserIdStr;
        result = this.toMemberView(target);
      });
    } finally {
      await session.endSession();
    }

    if (!result || !targetUserId) {
      throw new Error(
        'Membership update transaction completed without a result',
      );
    }
    // APRÈS le commit uniquement : jamais avant, jamais sur rollback.
    this.socketRegistry.disconnectMember(organizationId, targetUserId);
    return result;
  }

  /**
   * Transfert atomique de propriété (1-7C) — `ownership.transfer`,
   * `@OwnerOnly` (rôle STRICT, jamais via `permissions`). L'acteur ET la
   * cible sont RELUS dans la transaction. Ancien owner → `admin`/`active` ;
   * cible → `owner`/`active` ; garde défensive « exactement un owner actif »
   * AVANT commit (échec → transaction entière annulée, aucun état
   * intermédiaire observable).
   */
  async transferOwnership(
    organizationId: string,
    actorUserId: string,
    targetMembershipId: string,
  ): Promise<TransferOwnershipResult> {
    const orgOid = new Types.ObjectId(organizationId);
    const session = await this.connection.startSession();
    let result: TransferOwnershipResult | undefined;
    let previousOwnerUserId: string | undefined;
    let newOwnerUserId: string | undefined;

    try {
      await session.withTransaction(async () => {
        const actor = await this.membershipModel
          .findOne({
            userId: new Types.ObjectId(actorUserId),
            organizationId: orgOid,
          })
          .populate('userId', 'name email')
          .session(session)
          .exec();
        if (
          !actor ||
          actor.status !== MembershipStatus.ACTIVE ||
          actor.role !== OrganizationRole.OWNER
        ) {
          throw this.accessDenied();
        }

        const target = await this.membershipModel
          .findOne({
            _id: new Types.ObjectId(targetMembershipId),
            organizationId: orgOid,
          })
          .populate('userId', 'name email')
          .session(session)
          .exec();
        if (!target) throw new NotFoundException();

        const targetUserIdStr = String(
          (target.userId as unknown as { _id?: Types.ObjectId })._id ??
            target.userId,
        );
        if (targetUserIdStr === actorUserId) {
          throw new ConflictException({
            code: 'TRANSFER_TARGET_IS_CURRENT_OWNER',
            message: 'La cible est déjà propriétaire de cette organisation.',
          });
        }
        if (target.status !== MembershipStatus.ACTIVE) {
          throw new ConflictException({
            code: 'TRANSFER_TARGET_NOT_ACTIVE',
            message: 'La cible du transfert doit avoir une membership active.',
          });
        }

        actor.role = OrganizationRole.ADMIN;
        target.role = OrganizationRole.OWNER;
        await actor.save({ session });
        await target.save({ session });

        // Garde défensive AVANT commit (même esprit que
        // `createOwnerOrganization`) : jamais un état à 0 ou 2 owners actifs.
        const activeOwners = await this.membershipModel.countDocuments(
          {
            organizationId: orgOid,
            role: OrganizationRole.OWNER,
            status: MembershipStatus.ACTIVE,
          },
          { session },
        );
        if (activeOwners !== 1) {
          throw new Error(
            'Ownership transfer invariant violated: expected exactly one active owner.',
          );
        }

        previousOwnerUserId = actorUserId;
        newOwnerUserId = targetUserIdStr;
        result = {
          previousOwner: this.toMemberView(actor),
          newOwner: this.toMemberView(target),
        };
      });
    } finally {
      await session.endSession();
    }

    if (!result || !previousOwnerUserId || !newOwnerUserId) {
      throw new Error(
        'Ownership transfer transaction completed without a result',
      );
    }
    // APRÈS le commit uniquement : ancien ET nouveau owner rechargent leur
    // contexte à la prochaine connexion.
    this.socketRegistry.disconnectMember(organizationId, previousOwnerUserId);
    this.socketRegistry.disconnectMember(organizationId, newOwnerUserId);
    return result;
  }

  /** `GET /organizations/current` (1-8A) — accessible à tout membre actif. */
  async getCurrent(organizationId: string): Promise<OrganizationCurrentView> {
    const organization = await this.organizationModel
      .findOne({ _id: new Types.ObjectId(organizationId) })
      .exec();
    // Défensif : `OrganizationGuard` a déjà vérifié l'org active pour
    // cette requête ; une absence ici ne peut survenir que via un appel
    // direct au service (jamais atteint par les routes HTTP réelles).
    if (!organization) throw this.accessDenied();
    return this.toCurrentView(organization);
  }

  /**
   * Mutation du branding (1-8A) — `branding.manage`. Filtre EXACT
   * `{_id: organizationId}` (l'Organization EST le tenant, aucun champ
   * `organizationId` séparé) ; champs mis à jour EXPLICITEMENT, jamais un
   * spread du DTO. `newLogoKey` (déjà uploadé par le contrôleur AVANT cet
   * appel, jamais ici) n'est appliqué QUE s'il est fourni ; l'ancien
   * `logoKey` est retourné pour que le contrôleur supprime l'ancien objet
   * S3 APRÈS ce commit, jamais avant.
   */
  async updateBranding(
    organizationId: string,
    dto: UpdateBrandingDto,
    newLogoKey?: string,
  ): Promise<BrandingMutationResult> {
    if (
      dto.name === undefined &&
      dto.brandColor === undefined &&
      newLogoKey === undefined
    ) {
      throw new BadRequestException({
        code: 'EMPTY_BRANDING_UPDATE',
        message: 'Au moins un champ (name, brandColor, logo) est requis.',
      });
    }

    const organization = await this.organizationModel
      .findOne({ _id: new Types.ObjectId(organizationId) })
      .exec();
    if (!organization) throw this.accessDenied();

    const previousLogoKey = organization.logoKey;

    if (dto.name !== undefined) {
      const trimmed = dto.name.trim();
      if (!trimmed) {
        throw new BadRequestException({
          code: 'INVALID_BRANDING_NAME',
          message: 'name ne peut pas être vide.',
        });
      }
      organization.name = trimmed;
    }
    if (dto.brandColor !== undefined) organization.brandColor = dto.brandColor;
    if (newLogoKey !== undefined) organization.logoKey = newLogoKey;

    await organization.save();

    return {
      organization: this.toCurrentView(organization),
      // Rien à nettoyer côté contrôleur si AUCUN nouveau logo n'a été
      // uploadé (les champs name/brandColor seuls ne touchent jamais S3).
      previousLogoKey: newLogoKey !== undefined ? previousLogoKey : null,
    };
  }

  /**
   * Suppression du logo (1-8A) — `branding.manage`. DB mise à `null` AVANT
   * le nettoyage S3 (le contrôleur supprime l'ancien objet APRÈS ce
   * commit) ; no-op DB si déjà `null` (l'ancien `logoKey`, éventuellement
   * résiduel, est tout de même retourné pour un nettoyage idempotent).
   */
  async removeLogo(organizationId: string): Promise<BrandingMutationResult> {
    const organization = await this.organizationModel
      .findOne({ _id: new Types.ObjectId(organizationId) })
      .exec();
    if (!organization) throw this.accessDenied();

    const previousLogoKey = organization.logoKey;
    if (previousLogoKey !== null) {
      organization.logoKey = null;
      await organization.save();
    }
    return { organization: this.toCurrentView(organization), previousLogoKey };
  }

  private toCurrentView(
    organization: OrganizationDocument,
  ): OrganizationCurrentView {
    return {
      _id: organization._id.toString(),
      name: organization.name,
      slug: organization.slug,
      brandColor: organization.brandColor,
      currency: organization.currency,
      status: organization.status,
      logoUrl: organization.logoKey
        ? this.s3Service.publicUrlForKey(organization.logoKey)
        : null,
    };
  }

  private invitationInvalidOrExpired(): BadRequestException {
    return new BadRequestException({
      code: INVITATION_INVALID_OR_EXPIRED,
      message: 'Cette invitation est invalide ou a expiré.',
    });
  }

  private toMemberView(membership: OrganizationMembershipDocument): MemberView {
    // `userId` est soit un ObjectId brut (non peuplé), soit le document
    // `{_id,name,email}` peuplé par `listMembers` — jamais `password`.
    const populated = membership.userId as unknown as
      { _id: Types.ObjectId; name: string; email: string } | Types.ObjectId;
    const user =
      populated instanceof Types.ObjectId
        ? { _id: populated.toString(), name: '', email: '' }
        : {
            _id: populated._id.toString(),
            name: populated.name,
            email: populated.email,
          };
    return {
      membershipId: membership._id.toString(),
      user,
      role: membership.role,
      permissions: [...membership.permissions],
      status: membership.status,
      joinedAt: membership.joinedAt,
    };
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
