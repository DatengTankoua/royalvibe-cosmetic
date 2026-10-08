import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  DELEGABLE_PERMISSIONS,
  DelegablePermission,
  MembershipStatus,
  OrganizationRole,
} from '../permissions';

export type OrganizationMembershipDocument =
  HydratedDocument<OrganizationMembership>;

@Schema({ timestamps: true })
export class OrganizationMembership {
  @Prop({ required: true, type: Types.ObjectId, ref: 'Organization' })
  organizationId: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, ref: 'User' })
  userId: Types.ObjectId;

  /** Rôle dans l'organisation ; défaut `seller`. */
  @Prop({
    type: String,
    enum: OrganizationRole,
    default: OrganizationRole.SELLER,
  })
  role: OrganizationRole;

  /**
   * Permissions supplémentaires explicitement accordées (valeurs de
   * `DELEGABLE_PERMISSIONS` uniquement, sans doublon). L'autorisation
   * effective sera calculée plus tard comme :
   * permissions du rôle ∪ permissions supplémentaires (phase 1-7).
   *
   * `type: [String]` représente un tableau de chaînes typé et permet les
   * validations du tableau ; `Mixed` est évité parce qu'il est sans
   * schéma, n'effectue pas de casting et ne suit pas automatiquement
   * certaines modifications imbriquées.
   */
  @Prop({
    type: [String],
    default: [],
    validate: [
      {
        validator: (value: unknown) =>
          Array.isArray(value) &&
          value.every((entry) =>
            (DELEGABLE_PERMISSIONS as readonly unknown[]).includes(entry),
          ),
        message:
          'permissions : seules les permissions délégables connues sont autorisées',
      },
      {
        validator: (value: unknown) =>
          !Array.isArray(value) || new Set(value).size === value.length,
        message: 'permissions : les doublons ne sont pas autorisés',
      },
    ],
  })
  permissions: DelegablePermission[];

  /**
   * Un utilisateur peut posséder plusieurs memberships `active`
   * (plusieurs organisations, multi-appareils). Pas de champ « seule
   * membership active » : le champ `active: boolean` initial a été rejeté.
   */
  @Prop({
    type: String,
    enum: MembershipStatus,
    default: MembershipStatus.ACTIVE,
  })
  status: MembershipStatus;

  /** Invitant (piste d'audit) ; null si non invité. */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  invitedById: Types.ObjectId | null;

  @Prop({ type: Date, default: () => new Date() })
  joinedAt: Date;
}

export const OrganizationMembershipSchema = SchemaFactory.createForClass(
  OrganizationMembership,
);

OrganizationMembershipSchema.index(
  { organizationId: 1, userId: 1 },
  { unique: true },
);

OrganizationMembershipSchema.index({ userId: 1, status: 1 });

/**
 * Index unique PARTIEL « au plus un owner actif par organisation » :
 * - garantit QU'IL EXISTE AU MAXIMUM UN owner actif (2 owners = conflit) ;
 * - ne garantit PAS qu'un owner existe (l'invariant « exactement un owner »
 *   est assuré ultérieurement par le service + la transaction de
 *   transfert, phases 1-6/1-7+ ; cf. rapport 1A §2.2) ;
 * - un owner suspendu/révoqué libère le slot partiel par construction.
 */
OrganizationMembershipSchema.index(
  { organizationId: 1, role: 1 },
  {
    unique: true,
    partialFilterExpression: {
      role: OrganizationRole.OWNER,
      status: MembershipStatus.ACTIVE,
    },
  },
);
