import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  DELEGABLE_PERMISSIONS,
  DelegablePermission,
  InvitationStatus,
  OrganizationRole,
} from '../permissions';

export type OrganizationInvitationDocument =
  HydratedDocument<OrganizationInvitation>;

/** Rôles invitables : jamais `owner` (unique, transféré, pas invité — 1A §invitations). */
export const INVITABLE_ROLES = [
  OrganizationRole.ADMIN,
  OrganizationRole.SELLER,
] as const;

@Schema({ timestamps: true })
export class OrganizationInvitation {
  @Prop({ required: true, type: Types.ObjectId, ref: 'Organization' })
  organizationId: Types.ObjectId;

  @Prop({ required: true, trim: true, lowercase: true })
  email: string;

  @Prop({ type: String, enum: INVITABLE_ROLES, required: true })
  role: OrganizationRole;

  /** Permissions supplémentaires (mêmes règles que `OrganizationMembership.permissions`). */
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

  // Hash SHA-256 du token brut : jamais sélectionné par défaut, jamais en clair.
  @Prop({ required: true, unique: true, select: false })
  tokenHash: string;

  @Prop({ required: true, type: Types.ObjectId, ref: 'User' })
  invitedById: Types.ObjectId;

  @Prop({
    type: String,
    enum: InvitationStatus,
    default: InvitationStatus.PENDING,
  })
  status: InvitationStatus;

  @Prop({ required: true, type: Date })
  expiresAt: Date;

  @Prop({ type: Date, default: null })
  acceptedAt: Date | null;

  // 1-18B : lien de création de compte envoyé à l'adresse invitée (preuve
  // de contrôle de la boîte, distincte du lien remis au créateur). Hash
  // SHA-256 uniquement ; jamais sélectionnés par défaut.
  @Prop({ type: String, select: false })
  accountTokenHash?: string;

  @Prop({ type: Date, select: false })
  accountTokenExpiresAt?: Date;

  @Prop({ type: Date, select: false })
  accountLinkLastSentAt?: Date;

  @Prop({ type: Number, select: false })
  accountLinkSendCount?: number;
}

export const OrganizationInvitationSchema = SchemaFactory.createForClass(
  OrganizationInvitation,
);

// Liste par organisation, plus récentes d'abord — jamais de TTL (les
// invitations expirées sont conservées, marquées `expired` uniquement).
OrganizationInvitationSchema.index({
  organizationId: 1,
  status: 1,
  createdAt: -1,
});

// Au plus une invitation `pending` par (organisation, email).
OrganizationInvitationSchema.index(
  { organizationId: 1, email: 1 },
  {
    unique: true,
    partialFilterExpression: { status: InvitationStatus.PENDING },
  },
);

// 1-18B : recherche du lien de création de compte (invitations qui en ont un).
// Mêmes nom et options que la migration de pré-déploiement
// `create-invitation-account-token-index` (invitation-account-index.ts) :
// `autoIndex` et la migration aboutissent au même index, sans conflit.
OrganizationInvitationSchema.index(
  { accountTokenHash: 1 },
  {
    name: 'accountTokenHash_1',
    partialFilterExpression: { accountTokenHash: { $exists: true } },
  },
);
