import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import type { PushPreferences } from './push-category';

export type PushSubscriptionDocument = HydratedDocument<PushSubscriptionRecord>;

export const PUSH_SUBSCRIPTIONS_COLLECTION = 'push_subscriptions';

export enum PushSubscriptionStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
}

/** Raison générique de désactivation (jamais une réponse brute). */
export enum PushSubscriptionDisabledReason {
  /** Désactivation explicite ou déconnexion. */
  USER = 'user',
  /** Service push : `404` / `410` (abonnement expiré ou retiré). */
  GONE = 'gone',
  /** Session révoquée (version de session changée). */
  SESSION_REVOKED = 'session-revoked',
  /** Plafond d'appareils atteint : le plus ancien est remplacé. */
  REPLACED = 'replaced',
}

/**
 * 1-16A — Abonnement Web Push d'UN appareil (navigateur) pour UN utilisateur
 * dans UNE organisation. Utilisateur et organisation proviennent du contexte
 * serveur, jamais du corps. Un même `endpoint` (même navigateur) n'appartient
 * qu'à un seul couple utilisateur / organisation à la fois : un changement
 * de compte sur un appareil partagé le RÉATTRIBUE (préférences remises par
 * défaut), l'ancien titulaire ne reçoit plus rien sur cet appareil.
 *
 * `endpoint` et les clés ne sont JAMAIS journalisés ni renvoyés au client.
 * `autoIndex: false` : index créés par migration
 * (`migrate:push-notification-indexes`), vérifiés à l'activation.
 */
@Schema({
  collection: PUSH_SUBSCRIPTIONS_COLLECTION,
  timestamps: true,
  autoIndex: false,
})
export class PushSubscriptionRecord {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  })
  organizationId: Types.ObjectId;

  /** SHA-256 hexadécimal de l'endpoint : clé d'unicité. */
  @Prop({ type: String, required: true })
  endpointHash: string;

  @Prop({ type: String, required: true, maxlength: 2048 })
  endpoint: string;

  @Prop({ type: String, required: true, maxlength: 100 })
  p256dh: string;

  @Prop({ type: String, required: true, maxlength: 32 })
  auth: string;

  @Prop({
    type: {
      stockDepleted: { type: Boolean, required: true },
      // 1-16A.1 : trois catégories ajoutées (actives par défaut).
      stockLow: { type: Boolean, required: true, default: true },
      saleCreated: { type: Boolean, required: true, default: true },
      subscriptionEnding: { type: Boolean, required: true },
      paymentSucceeded: { type: Boolean, required: true },
      monthlyReport: { type: Boolean, required: true, default: true },
      // 1-19A : deux catégories ajoutées (actives par défaut).
      memberJoined: { type: Boolean, required: true, default: true },
      memberActivity: { type: Boolean, required: true, default: true },
    },
    _id: false,
    required: true,
  })
  preferences: PushPreferences;

  /** Version de session (`User.authVersion`) au moment de l'activation. */
  @Prop({ type: Number, required: true, min: 0 })
  authVersion: number;

  @Prop({
    type: String,
    enum: PushSubscriptionStatus,
    required: true,
    default: PushSubscriptionStatus.ACTIVE,
  })
  status: PushSubscriptionStatus;

  @Prop({
    type: String,
    enum: [...Object.values(PushSubscriptionDisabledReason), null],
    default: null,
  })
  disabledReason: PushSubscriptionDisabledReason | null;

  /** Horloge serveur (`PUSH_CLOCK`) : activation ou réattribution. */
  @Prop({ type: Date, required: true })
  registeredAt: Date;

  @Prop({ type: Date, default: null })
  disabledAt: Date | null;

  @Prop({ type: Date, default: null })
  lastDeliveredAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const PushSubscriptionSchema = SchemaFactory.createForClass(
  PushSubscriptionRecord,
);
