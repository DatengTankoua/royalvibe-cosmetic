import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { PushCategory } from './push-category';
import { SubscriptionPeriodKind } from '../../subscriptions/subscription-terms';

export type PushJobDocument = HydratedDocument<PushJob>;

export const PUSH_JOBS_COLLECTION = 'push_jobs';

/**
 * - `pending` : à répartir entre les destinataires (premier passage) ;
 * - `dispatched` : livraisons créées (une par appareil éligible) ;
 * - `cancelled` : plus pertinent au moment du traitement (produit
 *   réapprovisionné ou purgé, abonnement prolongé, délai dépassé…).
 */
export enum PushJobStatus {
  PENDING = 'pending',
  DISPATCHED = 'dispatched',
  CANCELLED = 'cancelled',
}

/**
 * 1-16A — Travail persistant d'UN événement métier (outbox). `eventKey`
 * unique : un rejeu ou une reprise ne crée jamais un second travail.
 * - `stock-depleted:<produit>:<écriture déclenchante>` (enregistré dans la
 *   transaction de la vente, même session) ;
 * - `payment-succeeded:<paiement>` (transaction d'attribution, même session) ;
 * - `subscription-ending:<organisation>:<échéance ms>` (balayage serveur).
 * 1-16A.1 :
 * - `stock-low:<produit>:<écriture déclenchante>` (même transaction) ;
 * - `sale-created:<vente>` (transaction de création) ;
 * - `monthly-report:<organisation>:<AAAA-MM>` (génération du bilan) ;
 * - `sale-digest:<organisation>:<début de fenêtre ms>` (push seul, regroupe
 *   les ventes d'une fenêtre fixe d'une minute).
 * Aucune donnée personnelle ni financière : identifiants seuls.
 */
@Schema({
  collection: PUSH_JOBS_COLLECTION,
  timestamps: true,
  autoIndex: false,
})
export class PushJob {
  @Prop({ type: String, required: true, maxlength: 200 })
  eventKey: string;

  @Prop({ type: String, enum: PushCategory, required: true })
  category: PushCategory;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  })
  organizationId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  productId: Types.ObjectId | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  paymentId: Types.ObjectId | null;

  /** 1-16A.1 : vente créée (`sale-created`). */
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  saleId: Types.ObjectId | null;

  /** 1-16A.1 : bilan mensuel (`monthly-report`). */
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  reportId: Types.ObjectId | null;

  /** Échéance effective visée par le rappel. */
  @Prop({ type: Date, default: null })
  coverageEndsAt: Date | null;

  @Prop({
    type: String,
    enum: [...Object.values(SubscriptionPeriodKind), null],
    default: null,
  })
  periodKind: SubscriptionPeriodKind | null;

  /** Heure de l'événement (horloge serveur `PUSH_CLOCK`). */
  @Prop({ type: Date, required: true })
  eventAt: Date;

  @Prop({
    type: String,
    enum: PushJobStatus,
    required: true,
    default: PushJobStatus.PENDING,
  })
  status: PushJobStatus;

  /** Code générique de clôture (`expired`, `restocked`, `renewed`…). */
  @Prop({ type: String, default: null, maxlength: 40 })
  outcome: string | null;

  @Prop({ type: Number, required: true, default: 0 })
  deliveries: number;

  @Prop({ type: Date, default: null })
  processedAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const PushJobSchema = SchemaFactory.createForClass(PushJob);
