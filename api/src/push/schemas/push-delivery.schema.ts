import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type PushDeliveryDocument = HydratedDocument<PushDelivery>;

export const PUSH_DELIVERIES_COLLECTION = 'push_deliveries';

/**
 * - `pending` : envoi à faire ou à reprendre (`nextAttemptAt`) ;
 * - `sending` : envoi en cours (verrou `lockedUntil`, repris après expiration
 *   s'il n'a pas abouti : livraison « au moins une fois », jamais promise
 *   « exactement une fois ») ;
 * - `sent` : accepté par le service push (2xx) ;
 * - `skipped` : plus pertinent ou destinataire plus autorisé ;
 * - `failed` : refus définitif, abonnement disparu ou reprises épuisées.
 */
export enum PushDeliveryStatus {
  PENDING = 'pending',
  SENDING = 'sending',
  SENT = 'sent',
  SKIPPED = 'skipped',
  FAILED = 'failed',
}

/**
 * 1-16A — Livraison d'UN travail à UN appareil. Unique
 * `{ jobId, subscriptionId }` : dédupliquée par événement et destinataire.
 */
@Schema({
  collection: PUSH_DELIVERIES_COLLECTION,
  timestamps: true,
  autoIndex: false,
})
export class PushDelivery {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'PushJob', required: true })
  jobId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  subscriptionId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  })
  organizationId: Types.ObjectId;

  @Prop({
    type: String,
    enum: PushDeliveryStatus,
    required: true,
    default: PushDeliveryStatus.PENDING,
  })
  status: PushDeliveryStatus;

  @Prop({ type: Number, required: true, default: 0 })
  attempts: number;

  @Prop({ type: Date, required: true })
  nextAttemptAt: Date;

  @Prop({ type: Date, default: null })
  lockedUntil: Date | null;

  /** Statut HTTP du dernier envoi, ou code générique (`network`, …). */
  @Prop({ type: String, default: null, maxlength: 40 })
  lastResult: string | null;

  @Prop({ type: Date, default: null })
  sentAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const PushDeliverySchema = SchemaFactory.createForClass(PushDelivery);
