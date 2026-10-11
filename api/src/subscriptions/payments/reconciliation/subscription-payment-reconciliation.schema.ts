import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { SubscriptionPaymentStatus } from '../schemas/subscription-payment.schema';

export const SUBSCRIPTION_PAYMENT_RECONCILIATIONS_COLLECTION =
  'subscription_payment_reconciliations';

/** Motifs STRUCTURÉS d'un rapprochement opérateur (jamais de texte libre). */
export enum ReconciliationReason {
  /** Relevé ou historique fourni par le prestataire. */
  PROVIDER_STATEMENT = 'provider-statement',
  /** Justificatif présenté par le client (reçu Mobile Money…). */
  CUSTOMER_EVIDENCE = 'customer-evidence',
  /** Ticket de support interne. */
  SUPPORT_TICKET = 'support-ticket',
  /** Investigation d'un paiement `review`. */
  REVIEW_INVESTIGATION = 'review-investigation',
  /** Initiation au résultat inconnu (`uncertain`). */
  UNCERTAIN_INITIATION = 'uncertain-initiation',
  /**
   * 1-21B — Page de paiement close sans succès (`checkout_unresolved`) :
   * le prestataire a confirmé à l'opérateur qu'aucun débit n'a eu lieu.
   */
  PROVIDER_CHECKOUT_CLOSED = 'provider-checkout-closed',
}

/** Action appliquée : déduite du statut VÉRIFIÉ, jamais saisie. */
export enum ReconciliationAction {
  SUCCEED = 'succeed',
  MARK_PENDING = 'mark-pending',
  FAIL = 'fail',
}

/**
 * 1-14D.2G — Audit MINIMAL des mutations opérateur, écrit dans la MÊME
 * transaction que le paiement (et la période éventuelle).
 *
 * `autoIndex: false` : index créés uniquement par la migration
 * `migrate:subscription-payment-reconciliation-indexes`, vérifiés par le CLI
 * avant toute mutation. Aucun TTL, aucune suppression.
 *
 * Jamais stockés : téléphone (même masqué), jeton, signature, secret,
 * réponse brute du prestataire.
 */
@Schema({
  collection: SUBSCRIPTION_PAYMENT_RECONCILIATIONS_COLLECTION,
  timestamps: false,
  autoIndex: false,
  strict: 'throw',
})
export class SubscriptionPaymentReconciliation {
  /** UUID v4 fourni par l'opérateur : identifiant d'opération STABLE. */
  @Prop({ type: String, required: true, immutable: true })
  operationId: string;

  /** Empreinte des paramètres de l'opération (rejeu / réutilisation). */
  @Prop({ type: String, required: true, immutable: true })
  requestFingerprint: string;

  /** Identifiant déclaré de l'opérateur (audit, pas une autorisation). */
  @Prop({ type: String, required: true, immutable: true })
  operatorId: string;

  @Prop({
    type: String,
    enum: Object.values(ReconciliationReason),
    required: true,
    immutable: true,
  })
  reasonCode: ReconciliationReason;

  @Prop({ type: String, default: null, immutable: true })
  reasonTicket: string | null;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    required: true,
    immutable: true,
  })
  paymentId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    required: true,
    immutable: true,
  })
  organizationId: Types.ObjectId;

  @Prop({ type: String, required: true, immutable: true })
  planToken: string;

  @Prop({
    type: String,
    enum: Object.values(ReconciliationAction),
    required: true,
    immutable: true,
  })
  action: ReconciliationAction;

  /** Référence CamPay consultée (normalisée en minuscules). */
  @Prop({ type: String, required: true, immutable: true })
  consultedReference: string;

  /** `true` : la référence a été RATTACHÉE par cette opération. */
  @Prop({ type: Boolean, required: true, immutable: true })
  referenceAttached: boolean;

  @Prop({
    type: String,
    enum: Object.values(SubscriptionPaymentStatus),
    required: true,
    immutable: true,
  })
  beforeStatus: SubscriptionPaymentStatus;

  @Prop({ type: String, default: null, immutable: true })
  beforeProviderReference: string | null;

  @Prop({
    type: String,
    enum: Object.values(SubscriptionPaymentStatus),
    required: true,
    immutable: true,
  })
  afterStatus: SubscriptionPaymentStatus;

  @Prop({ type: String, required: true, immutable: true })
  afterProviderReference: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null, immutable: true })
  afterPeriodId: Types.ObjectId | null;

  /** Faits VÉRIFIÉS (statut relu, normalisé) ; jamais la réponse brute. */
  @Prop({ type: String, required: true, immutable: true })
  verifiedState: string;

  @Prop({ type: String, required: true, immutable: true })
  verifiedProviderReference: string;

  @Prop({ type: String, required: true, immutable: true })
  verifiedMerchantReference: string;

  @Prop({ type: Number, required: true, immutable: true })
  verifiedAmount: number;

  @Prop({ type: String, required: true, immutable: true })
  verifiedCurrency: string;

  @Prop({ type: String, enum: ['applied'], required: true, immutable: true })
  result: 'applied';

  @Prop({ type: Date, required: true, immutable: true })
  appliedAt: Date;
}

export type SubscriptionPaymentReconciliationDocument =
  HydratedDocument<SubscriptionPaymentReconciliation>;

export const SubscriptionPaymentReconciliationSchema =
  SchemaFactory.createForClass(SubscriptionPaymentReconciliation);
