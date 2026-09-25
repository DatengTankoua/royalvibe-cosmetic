import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
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
import { CreateInvitationDto } from './dto/create-invitation.dto';

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

    const invitation = await this.invitationModel.create({
      organizationId: orgOid,
      email,
      role: dto.role,
      permissions: dto.permissions ?? [],
      tokenHash,
      invitedById: new Types.ObjectId(invitedById),
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    });

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
