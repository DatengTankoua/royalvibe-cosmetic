import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Organization,
  OrganizationDocument,
} from './schemas/organization.schema';
import {
  OrganizationMembership,
  OrganizationMembershipDocument,
} from './schemas/membership.schema';
import {
  DelegablePermission,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
} from './permissions';

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

@Injectable()
export class OrganizationsService {
  constructor(
    @InjectModel(Organization.name)
    private organizationModel: Model<OrganizationDocument>,
    @InjectModel(OrganizationMembership.name)
    private membershipModel: Model<OrganizationMembershipDocument>,
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

  private accessDenied(): ForbiddenException {
    // Message volontairement uniforme : ne révèle ni l'existence, ni le
    // statut (suspension/révocation) d'une organisation ou d'une membership.
    return new ForbiddenException({
      code: ORGANIZATION_ACCESS_DENIED,
      message: "Accès à l'organisation refusé.",
    });
  }
}
