import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { SubscriptionTerm } from '../../subscription-terms';

export type SubscriptionPaymentDocument = HydratedDocument<SubscriptionPayment>;

export const SUBSCRIPTION_PAYMENTS_COLLECTION = 'subscription_payments';

/**
 * 1-14D.2B — États d'une demande de paiement.
 *
 * Ouverts (`open: true`, bloquent toute nouvelle collecte) :
 * - `initiating` : demande persistée, droit d'initier réservé ;
 * - `pending`    : collecte acceptée par le prestataire, en attente du payeur ;
 * - `uncertain`  : issue de l'initiation inconnue (réponse perdue) — JAMAIS
 *   un échec, jamais réinitié ;
 * - `review`     : discordance (montant, devise, référence) — traitement
 *   opérateur, aucune attribution (conserve `open` de l'état précédent).
 * Fermés : `succeeded` (terminal, période attribuée), `failed` (refus
 * confirmé ; seul un succès vérifié peut encore le faire évoluer).
 */
export enum SubscriptionPaymentStatus {
  INITIATING = 'initiating',
  PENDING = 'pending',
  UNCERTAIN = 'uncertain',
  REVIEW = 'review',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}

/** Codes d'incident GÉNÉRIQUES (jamais un message ou une réponse brute). */
export enum SubscriptionPaymentIncident {
  INITIATION_REJECTED = 'initiation_rejected',
  INITIATION_UNCERTAIN = 'initiation_uncertain',
  PROVIDER_UNAVAILABLE = 'provider_unavailable',
  PROVIDER_MISMATCH = 'provider_mismatch',
  LATE_FAILURE_AFTER_SUCCESS = 'late_failure_after_success',
  /**
   * 1-21B — page de paiement close ou tentative échouée sans succès
   * constaté : paiement OUVERT, à vérifier (succès tardif encore accepté).
   */
  CHECKOUT_UNRESOLVED = 'checkout_unresolved',
  /** 1-21B — réponses du prestataire incohérentes : vérification opérateur. */
  PROVIDER_INCONSISTENT = 'provider_inconsistent',
}

/**
 * Registre des demandes de paiement d'abonnement. `autoIndex: false` : les
 * index ne sont JAMAIS créés au démarrage (migration
 * `migrate:subscription-payment-indexes`, vérification fail-fast en
 * production). Aucun TTL, aucune suppression automatique.
 *
 * Jamais stockés : téléphone en clair, PIN, jeton, secret, réponse brute du
 * prestataire.
 */
@Schema({
  collection: SUBSCRIPTION_PAYMENTS_COLLECTION,
  timestamps: true,
  autoIndex: false,
})
export class SubscriptionPayment {
  /** Contexte serveur (`OrganizationGuard`), jamais le corps. */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    immutable: true,
  })
  organizationId: Types.ObjectId;

  /** Propriétaire authentifié (`sub` du JWT). */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true,
  })
  requestedBy: Types.ObjectId;

  /** UUID v4 en minuscules, généré une fois par le client. */
  @Prop({ type: String, required: true, immutable: true })
  clientOperationId: string;

  /** HMAC de la demande normalisée ; jamais exposé. */
  @Prop({ type: String, required: true, immutable: true })
  requestFingerprint: string;

  @Prop({
    type: String,
    enum: SubscriptionTerm,
    required: true,
    immutable: true,
  })
  term: SubscriptionTerm;

  /** Montant TOTAL figé depuis le catalogue serveur (XAF, entier). */
  @Prop({
    type: Number,
    required: true,
    immutable: true,
    min: 1,
    validate: {
      validator: (value: unknown) => Number.isSafeInteger(value),
      message: 'amount doit être un entier.',
    },
  })
  amount: number;

  @Prop({ type: String, enum: ['XAF'], required: true, immutable: true })
  currency: 'XAF';

  @Prop({ type: Number, required: true, immutable: true, min: 1 })
  pricingVersion: number;

  @Prop({ type: String, required: true, immutable: true })
  provider: string;

  @Prop({ type: String, required: true, immutable: true })
  merchantReference: string;

  @Prop({ type: String, default: null })
  providerReference: string | null;

  @Prop({
    type: String,
    enum: SubscriptionPaymentStatus,
    required: true,
  })
  status: SubscriptionPaymentStatus;

  @Prop({ type: Boolean, required: true })
  open: boolean;

  /**
   * 1-21B — `null` quand le prestataire n'a demandé aucun numéro (page de
   * paiement hébergée) ; jamais le numéro en clair.
   */
  @Prop({ type: String, default: null, immutable: true })
  payerPhoneMasked: string | null;

  /**
   * 1-21B — Page de paiement hébergée VALIDÉE (HTTPS, hôte autorisé du
   * prestataire), rouverte telle quelle par le payeur : jamais une nouvelle
   * session pour un retour ou un rechargement. Aucun secret.
   */
  @Prop({ type: String, default: null })
  providerCheckoutUrl: string | null;

  /**
   * 1-21B — Transaction du prestataire RATTACHÉE (lue sur sa session) :
   * unique par prestataire (index partiel), jamais deux paiements internes.
   */
  @Prop({ type: String, default: null })
  providerTransactionId: string | null;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'SubscriptionPeriod',
    default: null,
  })
  periodId: Types.ObjectId | null;

  @Prop({
    type: String,
    enum: [...Object.values(SubscriptionPaymentIncident), null],
    default: null,
  })
  incidentCode: SubscriptionPaymentIncident | null;

  @Prop({ type: Date, default: null })
  initiatedAt: Date | null;

  @Prop({ type: Date, default: null })
  confirmedAt: Date | null;

  @Prop({ type: Date, default: null })
  failedAt: Date | null;

  @Prop({ type: Date, default: null })
  lastCheckedAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const SubscriptionPaymentSchema =
  SchemaFactory.createForClass(SubscriptionPayment);

export const OPEN_PAYMENT_STATUSES: readonly SubscriptionPaymentStatus[] =
  Object.freeze([
    SubscriptionPaymentStatus.INITIATING,
    SubscriptionPaymentStatus.PENDING,
    SubscriptionPaymentStatus.UNCERTAIN,
  ]);
