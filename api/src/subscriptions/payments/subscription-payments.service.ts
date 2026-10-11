import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  SubscriptionGrantError,
  SubscriptionsService,
} from '../subscriptions.service';
import { SubscriptionSource, SubscriptionTerm } from '../subscription-terms';
import {
  SubscriptionPricingError,
  getSubscriptionPrice,
} from '../subscription-pricing';
import { SUBSCRIPTION_CLOCK } from '../subscription-clock';
import { SubscriptionSignalsService } from '../subscription-signals.service';
import { PushOutboxService } from '../../push/push-outbox.service';
import type { SubscriptionClock } from '../subscription-clock';
import {
  OPEN_PAYMENT_STATUSES,
  SubscriptionPayment,
  SubscriptionPaymentDocument,
  SubscriptionPaymentIncident,
  SubscriptionPaymentStatus,
} from './schemas/subscription-payment.schema';
import {
  PAYMENT_CONFIRMATION_PROVIDERS,
  PAYMENT_CURRENCY,
  PAYMENT_PROVIDER,
  PaymentInitiationResult,
  PaymentProviderInconsistencyError,
  PaymentProviderUnavailableError,
  confirmationProviderFor,
} from './payment-provider';
import type {
  PaymentProvider,
  PaymentStatusLookup,
  ProviderPaymentStatus,
} from './payment-provider';
import {
  computePaymentRequestFingerprint,
  derivePaymentFingerprintKey,
  maskPayerPhone,
  merchantReferenceFor,
  normalizePayerPhone,
  paymentGrantReference,
} from './payment-request';
import { subscriptionPaymentDuplicateKeyIndex } from './subscription-payment-indexes';
import { paymentConcordanceMismatches } from './payment-concordance';
import type { MongooseSession } from '../subscriptions.service';
import {
  invalidPayerPhone,
  paymentAlreadyPending,
  paymentConfirmationPending,
  paymentNotFound,
  paymentOperationConflict,
  paymentServiceUnavailable,
  paymentStatusUnavailable,
} from './payment-errors';
import {
  PAYMENT_HISTORY_DEFAULT_LIMIT,
  PAYMENT_HISTORY_MAX_LIMIT,
} from './dto/subscription-payment.dto';

/**
 * Budget GLOBAL (ms) de la phase transactionnelle d'une confirmation :
 * reprises applicatives (≤ 5) ET reprises automatiques du driver comprises.
 */
export const PAYMENT_CONFIRMATION_BUDGET_MS = 30_000;

/**
 * 1-21B — Origine publique du web (`PUBLIC_APP_URL` validée) pour l'URL de
 * retour d'une page de paiement hébergée ; jamais une valeur du client.
 */
export const PAYMENT_RETURN_ORIGIN = Symbol('PAYMENT_RETURN_ORIGIN');

/**
 * Page du web où revient le payeur : un retour ne prouve RIEN (le web
 * demande seulement une vérification serveur).
 */
export const PAYMENT_RETURN_PATH = '/app/organization/subscription';

/** Contexte SERVEUR de la requête (jamais le corps). */
export interface PaymentRequestContext {
  organizationId: string;
  userId: string;
}

export interface CreatePaymentInput {
  term: string;
  /**
   * 1-21B — facultatif : exigé seulement par un prestataire qui pousse la
   * collecte sur le téléphone (`requiresPayerPhone`) ; ignoré sinon.
   */
  payerPhone?: string | null;
  clientOperationId: string;
  /**
   * 1-21B — compte AUTORISÉ du demandeur (lu par le contrôleur sur
   * l'utilisateur authentifié), transmis au seul prestataire qui l'exige.
   */
  payer?: { email: string; name: string };
}

/** 1-21B — moyen de paiement des NOUVELLES tentatives (jamais un secret). */
export interface PaymentCapabilities {
  available: boolean;
  method: 'hosted-checkout' | 'mobile-money' | null;
}

/** Projection EXPLICITE exposée au propriétaire. */
export interface SubscriptionPaymentView {
  paymentId: string;
  reference: string;
  status: SubscriptionPaymentStatus;
  term: SubscriptionTerm;
  amount: number;
  currency: 'XAF';
  payerPhoneMasked: string | null;
  /**
   * 1-21B — page de paiement hébergée à rouvrir (paiement ouvert
   * seulement) ; aucun secret, aucune nouvelle session.
   */
  checkoutUrl: string | null;
  createdAt: string | null;
  initiatedAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
}

export type PaymentRecord = SubscriptionPayment & { _id: Types.ObjectId };

/** États pouvant encore aboutir à un succès VÉRIFIÉ (jamais `review`). */
const FINALIZABLE_STATUSES: readonly SubscriptionPaymentStatus[] =
  Object.freeze([...OPEN_PAYMENT_STATUSES, SubscriptionPaymentStatus.FAILED]);

const isStrictObjectId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value);

const iso = (date: Date | null | undefined): string | null =>
  date ? date.toISOString() : null;

/**
 * 1-14D.2B — Demandes de paiement d'abonnement et moteur de confirmation.
 *
 * - Initiation : demande + référence marchand PERSISTÉES avant tout effet
 *   externe ; l'insertion (index `open` et `clientOperationId`) RÉSERVE
 *   atomiquement le droit d'initier : un seul appel réseau par paiement,
 *   jamais relancé.
 * - Confirmation (`confirmPayment`) : UNIQUE point d'entrée (refresh
 *   propriétaire, webhook 1-14D.2F inactif en production, futurs scripts). Statut lu hors transaction,
 *   concordance vérifiée, puis attribution `source: payment` et marquage
 *   `succeeded` dans UNE transaction (`runInGrantTransaction`), sans réseau.
 * - Aucun échec automatique sur délai : seul un refus CONFIRMÉ par le
 *   prestataire ferme un paiement.
 * - Ne modifie jamais un rôle, une permission ni `Organization.status`.
 *
 * 1-15F — signaux temps réel (`SubscriptionSignalsService`, payload `{}`),
 * émis APRÈS l'écriture validée et seulement si elle a changé l'état
 * visible : `payments:changed` (création, `pending`, `failed`, `review`,
 * `succeeded`) et `subscription:changed` (période attribuée, après le
 * commit de `runInGrantTransaction`, jamais dans son callback rejouable).
 * Rien sur un rejeu, un refus, un rollback, une écriture conditionnelle
 * sans effet ni la seule date de consultation. Un signal ne déclenche
 * jamais de consultation du prestataire.
 */
@Injectable()
export class SubscriptionPaymentsService {
  private readonly fingerprintKey: Buffer;

  constructor(
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPaymentDocument>,
    private readonly subscriptions: SubscriptionsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(SUBSCRIPTION_CLOCK) private readonly clock: SubscriptionClock,
    private readonly signals: SubscriptionSignalsService,
    config: ConfigService,
    // 1-16A : optionnel (tests unitaires construits sans module push).
    @Optional() private readonly pushOutbox?: PushOutboxService,
    // 1-21B : adaptateurs des paiements déjà engagés (facultatif).
    @Optional()
    @Inject(PAYMENT_CONFIRMATION_PROVIDERS)
    private readonly confirmers?: readonly PaymentProvider[],
    // 1-21B : origine publique du web (URL de retour), jamais une requête.
    @Optional()
    @Inject(PAYMENT_RETURN_ORIGIN)
    private readonly returnOrigin?: string | null,
  ) {
    this.fingerprintKey = derivePaymentFingerprintKey(
      config.getOrThrow<string>('JWT_SECRET'),
    );
  }

  /** 1-21B — vérifications concurrentes d'un même paiement regroupées. */
  private readonly confirmations = new Map<
    string,
    Promise<SubscriptionPaymentView>
  >();

  /** 1-21B — moyen de paiement proposé pour une NOUVELLE tentative. */
  capabilities(): PaymentCapabilities {
    if (!this.provider.available) return { available: false, method: null };
    return {
      available: true,
      method:
        this.provider.requiresPayerPhone === false
          ? 'hosted-checkout'
          : 'mobile-money',
    };
  }

  // ─── Initiation ────────────────────────────────────────────────────────────

  async createPayment(
    context: PaymentRequestContext,
    input: CreatePaymentInput,
  ): Promise<{ payment: SubscriptionPaymentView; replayed: boolean }> {
    let price: ReturnType<typeof getSubscriptionPrice>;
    try {
      price = getSubscriptionPrice(input.term);
    } catch (error) {
      if (error instanceof SubscriptionPricingError) {
        throw new BadRequestException({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
    // 1-21B : numéro facultatif ; s'il est fourni, il doit être valide et
    // entre dans l'empreinte (rejeu identique quel que soit le prestataire
    // actif au moment du rejeu).
    const provided =
      input.payerPhone === undefined ||
      input.payerPhone === null ||
      input.payerPhone.trim() === ''
        ? null
        : input.payerPhone;
    const payerPhone = provided === null ? null : normalizePayerPhone(provided);
    if (provided !== null && !payerPhone) throw invalidPayerPhone();

    const organizationId = new Types.ObjectId(context.organizationId);
    const requestedBy = new Types.ObjectId(context.userId);
    const clientOperationId = input.clientOperationId.toLowerCase();
    const fingerprint = computePaymentRequestFingerprint(this.fingerprintKey, {
      requestedBy: requestedBy.toHexString(),
      term: price.term,
      payerPhone: payerPhone ?? '',
    });

    // 1. Rejeu AVANT toute nouvelle initiation (aucun réseau).
    const existing = await this.findOperation(
      organizationId,
      clientOperationId,
    );
    if (existing) return this.replay(existing, requestedBy, fingerprint);

    // 2. Prestataire indisponible : aucune écriture, aucun réseau.
    if (!this.provider.available) throw paymentServiceUnavailable();
    const needsPhone = this.provider.requiresPayerPhone !== false;
    if (needsPhone && !payerPhone) throw invalidPayerPhone();
    if (!needsPhone && !input.payer) throw paymentServiceUnavailable();

    // 3. Un seul paiement ouvert par organisation.
    const open = await this.paymentModel
      .findOne({ organizationId, open: true })
      .select({ _id: 1 })
      .lean()
      .exec();
    if (open) throw paymentAlreadyPending(String(open._id));

    // 4. Persistance + réservation atomique (tarif FIGÉ à cet instant).
    const _id = new Types.ObjectId();
    const merchantReference = merchantReferenceFor(_id);
    try {
      await this.paymentModel.create({
        _id,
        organizationId,
        requestedBy,
        clientOperationId,
        requestFingerprint: fingerprint,
        term: price.term,
        amount: price.amount,
        currency: price.currency,
        pricingVersion: price.pricingVersion,
        provider: this.provider.name,
        merchantReference,
        providerReference: null,
        status: SubscriptionPaymentStatus.INITIATING,
        open: true,
        payerPhoneMasked:
          needsPhone && payerPhone ? maskPayerPhone(payerPhone) : null,
      });
    } catch (error) {
      const index = subscriptionPaymentDuplicateKeyIndex(error);
      if (index === 'organizationId_1_clientOperationId_1') {
        // Double clic concurrent : l'autre appel a réservé ; rejeu.
        const winner = await this.findOperation(
          organizationId,
          clientOperationId,
        );
        if (winner) return this.replay(winner, requestedBy, fingerprint);
      }
      if (index === 'organizationId_1_single_open_payment') {
        const other = await this.paymentModel
          .findOne({ organizationId, open: true })
          .select({ _id: 1 })
          .lean()
          .exec();
        throw paymentAlreadyPending(String(other?._id ?? ''));
      }
      throw error;
    }

    // 1-15F : paiement créé (écriture validée) → un signal en fin de
    // traitement, quelle que soit l'issue de l'initiation.
    try {
      return await this.initiateReserved(
        _id,
        price,
        needsPhone ? payerPhone : null,
        needsPhone ? undefined : input.payer,
      );
    } finally {
      this.signalPayments(organizationId);
    }
  }

  /** Étape 5 de `createPayment`, sur le paiement RÉSERVÉ `_id`. */
  private async initiateReserved(
    _id: Types.ObjectId,
    price: ReturnType<typeof getSubscriptionPrice>,
    payerPhone: string | null,
    payer: { email: string; name: string } | undefined,
  ): Promise<{ payment: SubscriptionPaymentView; replayed: boolean }> {
    const merchantReference = merchantReferenceFor(_id);
    const returnUrl = this.returnOrigin
      ? `${this.returnOrigin}${PAYMENT_RETURN_PATH}?payment=${_id.toHexString()}`
      : undefined;
    // 5. UN SEUL appel réseau, hors de toute transaction.
    let result: PaymentInitiationResult;
    try {
      result = await this.provider.initiate({
        merchantReference,
        amount: price.amount,
        currency: PAYMENT_CURRENCY,
        payerPhone,
        // 1-21B : page hébergée → référence aussi dans le libellé (indice
        // lisible par l'opérateur, jamais une preuve) ; CamPay inchangé.
        description: payer
          ? `Abonnement Stock Master (${price.months} mois) ${merchantReference}`
          : `Abonnement Stock Master (${price.months} mois)`,
        ...(payer ? { customer: payer } : {}),
        ...(returnUrl ? { returnUrl } : {}),
      });
    } catch (error) {
      if (error instanceof PaymentProviderUnavailableError) {
        // Requête certainement non transmise : aucune collecte possible.
        await this.transition(_id, [SubscriptionPaymentStatus.INITIATING], {
          status: SubscriptionPaymentStatus.FAILED,
          open: false,
          failedAt: this.clock(),
          incidentCode: SubscriptionPaymentIncident.PROVIDER_UNAVAILABLE,
        });
        throw paymentServiceUnavailable();
      }
      // Issue inconnue : la collecte existe PEUT-ÊTRE. Paiement conservé,
      // même référence, ouvert ; jamais réinitié, jamais déclaré échoué.
      await this.transition(_id, [SubscriptionPaymentStatus.INITIATING], {
        status: SubscriptionPaymentStatus.UNCERTAIN,
        incidentCode: SubscriptionPaymentIncident.INITIATION_UNCERTAIN,
      });
      return { payment: await this.viewById(_id), replayed: false };
    }

    if (result.outcome === 'rejected') {
      await this.transition(_id, [SubscriptionPaymentStatus.INITIATING], {
        status: SubscriptionPaymentStatus.FAILED,
        open: false,
        failedAt: this.clock(),
        incidentCode: SubscriptionPaymentIncident.INITIATION_REJECTED,
      });
    } else {
      await this.recordPending(
        _id,
        result.providerReference,
        [SubscriptionPaymentStatus.INITIATING],
        { checkoutUrl: result.redirectUrl ?? null },
      );
    }
    return { payment: await this.viewById(_id), replayed: false };
  }

  // ─── Lectures locales (toujours possibles, prestataire indisponible) ───────

  async getPayment(
    context: PaymentRequestContext,
    paymentId: string,
  ): Promise<SubscriptionPaymentView> {
    return this.toView(await this.findScoped(context, paymentId));
  }

  async listPayments(
    context: PaymentRequestContext,
    query: { limit?: number; before?: string },
  ): Promise<{ items: SubscriptionPaymentView[]; nextCursor: string | null }> {
    const limit = Math.min(
      Math.max(query.limit ?? PAYMENT_HISTORY_DEFAULT_LIMIT, 1),
      PAYMENT_HISTORY_MAX_LIMIT,
    );
    const filter: Record<string, unknown> = {
      organizationId: new Types.ObjectId(context.organizationId),
    };
    if (query.before !== undefined) {
      if (!isStrictObjectId(query.before)) throw paymentNotFound();
      filter._id = { $lt: new Types.ObjectId(query.before) };
    }
    const rows = await this.paymentModel
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean<PaymentRecord[]>()
      .exec();
    const page = rows.slice(0, limit);
    return {
      items: page.map((p) => this.toView(p)),
      nextCursor:
        rows.length > limit ? page[page.length - 1]._id.toHexString() : null,
    };
  }

  // ─── Confirmation ──────────────────────────────────────────────────────────

  /** Refresh propriétaire : paiement de l'organisation COURANTE seulement. */
  async refreshPayment(
    context: PaymentRequestContext,
    paymentId: string,
  ): Promise<SubscriptionPaymentView> {
    const payment = await this.findScoped(context, paymentId);
    return this.confirmPaymentShared(payment._id);
  }

  /**
   * Point d'entrée UNIQUE de confirmation (refresh, futurs webhook et
   * scripts). Ne fait confiance qu'au statut LU chez le prestataire et
   * vérifié contre les valeurs figées.
   *
   * - `succeeded` local → rejeu, aucun réseau, aucune nouvelle période ;
   * - `review` → inchangé (traitement opérateur) ;
   * - statut indisponible → 503, état conservé ;
   * - discordance → `review`, aucune attribution ;
   * - refus confirmé → `failed` (jamais après un succès) ;
   * - succès concordant → attribution + `succeeded`, atomiquement.
   */
  confirmPayment(paymentId: Types.ObjectId): Promise<SubscriptionPaymentView> {
    return this.confirmOnce(paymentId);
  }

  /**
   * 1-21B — Même confirmation, REGROUPÉE : une seule vérification en cours
   * par paiement dans ce processus (refresh, retour du payeur, webhooks
   * SasPay concurrents) ; les appels simultanés partagent son résultat et
   * n'appellent le prestataire qu'une fois. La garantie d'attribution
   * unique reste celle de la transaction (plusieurs processus).
   */
  confirmPaymentShared(
    paymentId: Types.ObjectId,
  ): Promise<SubscriptionPaymentView> {
    const key = paymentId.toHexString();
    const running = this.confirmations.get(key);
    if (running) return running;
    const started = this.confirmOnce(paymentId).finally(() => {
      this.confirmations.delete(key);
    });
    this.confirmations.set(key, started);
    return started;
  }

  private async confirmOnce(
    paymentId: Types.ObjectId,
  ): Promise<SubscriptionPaymentView> {
    const payment = await this.findById(paymentId);
    if (!payment) throw paymentNotFound();
    if (payment.status === SubscriptionPaymentStatus.SUCCEEDED) {
      return this.toView(payment);
    }
    if (payment.status === SubscriptionPaymentStatus.REVIEW) {
      return this.toView(payment);
    }
    // 1-21B : chaque paiement est confirmé par SON prestataire, jamais par
    // un autre ; disponible même si les nouvelles tentatives sont coupées.
    const provider = confirmationProviderFor(
      payment.provider,
      this.provider,
      this.confirmers,
    );
    if (!provider) throw paymentServiceUnavailable();

    const lookup = this.lookupFor(payment, provider);
    // Initiation incertaine sans recherche par référence marchand : rien ne
    // permet de conclure ; état conservé (jamais une nouvelle collecte).
    if (!lookup) return this.toView(payment);

    let status: ProviderPaymentStatus | null;
    try {
      status = await provider.fetchStatus(lookup);
    } catch (error) {
      if (error instanceof PaymentProviderInconsistencyError) {
        // Jamais départagé arbitrairement : vérification opérateur.
        if (
          await this.markReview(
            payment._id,
            SubscriptionPaymentIncident.PROVIDER_INCONSISTENT,
          )
        ) {
          this.signalPayments(payment.organizationId);
        }
        return this.viewById(payment._id);
      }
      throw paymentStatusUnavailable();
    }
    // Date de consultation seule : absente de la vue, aucun signal.
    await this.paymentModel
      .updateOne(
        { _id: payment._id },
        { $set: { lastCheckedAt: this.clock() } },
      )
      .exec();
    if (!status) return this.viewById(payment._id);

    // 1-15F : `changed` n'est vrai qu'après une écriture validée qui a
    // modifié l'état visible ; le signal part ensuite, même si la relecture
    // finale échoue.
    let changed = false;
    try {
      if (!this.concordant(payment, status)) {
        changed = await this.markReview(payment._id);
        return await this.viewById(payment._id);
      }

      switch (status.state) {
        case 'pending':
          changed = await this.recordPending(
            payment._id,
            status.providerReference,
            [
              SubscriptionPaymentStatus.INITIATING,
              SubscriptionPaymentStatus.PENDING,
              SubscriptionPaymentStatus.UNCERTAIN,
            ],
            {
              checkoutUrl: status.checkoutUrl,
              providerTransactionId: status.providerTransactionId,
            },
          );
          break;
        case 'unresolved':
          changed = await this.recordUnresolved(payment._id, status);
          break;
        case 'failed':
          changed = await this.recordFailure(
            payment._id,
            status.providerReference,
          );
          break;
        case 'succeeded': {
          const outcome = await this.finalize(payment._id, status);
          changed = outcome !== 'unchanged';
          // Transaction VALIDÉE (`runInGrantTransaction` a rendu la main
          // après le commit) : nouvelle période visible.
          if (outcome === 'granted') {
            void this.signals.subscriptionChanged(
              payment.organizationId.toHexString(),
            );
          }
          break;
        }
      }
      return await this.viewById(payment._id);
    } finally {
      if (changed) this.signalPayments(payment.organizationId);
    }
  }

  /**
   * 1-14D.2F — Localisation d'un paiement EXISTANT pour une notification du
   * prestataire, en LECTURE SEULE (aucune création, aucune référence
   * adoptée) :
   * - `found` : référence prestataire PERSISTÉE identique → le déclencheur
   *   appellera `confirmPayment` (statut relu chez le prestataire) ;
   * - `not-ready` : aucune correspondance, mais l'indice marchand (non
   *   prouvé) désigne un paiement encore `initiating` sans référence
   *   prestataire : notification possiblement arrivée avant l'enregistrement
   *   de la réponse d'initiation → réponse temporaire ;
   * - `unknown` : rien à faire.
   */
  async locateProviderNotification(
    providerName: string,
    providerReference: string,
    merchantReferenceHint: string | null,
  ): Promise<
    | { kind: 'found'; paymentId: Types.ObjectId }
    | { kind: 'not-ready' }
    | { kind: 'unknown' }
  > {
    const payment = await this.paymentModel
      .findOne({ provider: providerName, providerReference })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }>()
      .exec();
    if (payment) return { kind: 'found', paymentId: payment._id };
    if (merchantReferenceHint) {
      const initiating = await this.paymentModel
        .findOne({
          provider: providerName,
          merchantReference: merchantReferenceHint,
          status: SubscriptionPaymentStatus.INITIATING,
          providerReference: null,
        })
        .select({ _id: 1 })
        .lean()
        .exec();
      if (initiating) return { kind: 'not-ready' };
    }
    return { kind: 'unknown' };
  }

  // ─── Internes ──────────────────────────────────────────────────────────────

  private lookupFor(
    payment: PaymentRecord,
    provider: PaymentProvider,
  ): PaymentStatusLookup | null {
    if (payment.providerReference) {
      return { by: 'provider', providerReference: payment.providerReference };
    }
    return provider.supportsMerchantReferenceLookup
      ? { by: 'merchant', merchantReference: payment.merchantReference }
      : null;
  }

  /**
   * Concordance STRICTE avec les valeurs figées : référence marchand,
   * référence prestataire (si déjà connue), montant brut exact (nombre
   * entier, aucune conversion), devise.
   */
  private concordant(
    payment: Pick<
      PaymentRecord,
      | 'merchantReference'
      | 'providerReference'
      | 'amount'
      | 'currency'
      | 'providerTransactionId'
    >,
    status: ProviderPaymentStatus,
  ): boolean {
    return (
      paymentConcordanceMismatches(payment, status, payment.providerReference)
        .length === 0
    );
  }

  /**
   * Succès VÉRIFIÉ → transaction complète (socle 1-14D.2A, sans réseau) :
   * relecture, revérification des valeurs figées, attribution
   * `payment:<id>`, marquage conditionnel `succeeded` + période.
   */
  private async finalize(
    paymentId: Types.ObjectId,
    verified: ProviderPaymentStatus,
  ): Promise<'granted' | 'review' | 'unchanged'> {
    let outcome: 'granted' | 'replayed' | 'not-finalizable' | 'mismatch';
    try {
      outcome = await this.subscriptions.runInGrantTransaction(
        async (session) => {
          const current = await this.paymentModel
            .findById(paymentId)
            .session(session)
            .lean<PaymentRecord>()
            .exec();
          if (!current) throw new Error('Subscription payment vanished');
          if (current.status === SubscriptionPaymentStatus.SUCCEEDED) {
            return 'replayed' as const;
          }
          if (!FINALIZABLE_STATUSES.includes(current.status)) {
            return 'not-finalizable' as const;
          }
          if (!this.concordant(current, verified)) {
            return 'mismatch' as const;
          }
          await this.grantAndMarkSucceededInSession(session, current, verified);
          // 1-16A — « paiement confirmé » enregistré dans CETTE transaction,
          // après attribution et passage à `succeeded` : annulé par un
          // rollback, unique par paiement sur un rejeu du callback. Jamais
          // pour `pending`, `uncertain` ni `review`.
          await this.pushOutbox?.paymentSucceededInSession(session, {
            organizationId: current.organizationId,
            paymentId: current._id,
          });
          return 'granted' as const;
        },
        { budgetMs: PAYMENT_CONFIRMATION_BUDGET_MS },
      );
    } catch (error) {
      // Budget épuisé ou contention persistante : réponse TEMPORAIRE, aucun
      // changement d'état (jamais `failed`), aucune nouvelle collecte. Un
      // commit éventuellement validé sera retrouvé (rejeu) au prochain appel.
      if (
        error instanceof SubscriptionGrantError &&
        (error.code === 'GRANT_TIMEOUT' || error.code === 'GRANT_CONTENTION')
      ) {
        throw paymentConfirmationPending();
      }
      // Référence prestataire déjà portée par un autre paiement : anomalie.
      const duplicate = subscriptionPaymentDuplicateKeyIndex(error);
      if (
        duplicate === 'provider_1_providerReference_1' ||
        duplicate === 'provider_1_providerTransactionId_1'
      ) {
        return (await this.markReview(paymentId)) ? 'review' : 'unchanged';
      }
      throw error;
    }
    if (outcome === 'granted') return 'granted';
    if (outcome === 'mismatch') {
      return (await this.markReview(paymentId)) ? 'review' : 'unchanged';
    }
    return 'unchanged';
  }

  /**
   * Attribution `source: payment` (`payment:<id>`, `payment:<prestataire>`)
   * et marquage `succeeded` + période, dans la transaction ACTIVE de
   * l'appelant (aucun réseau). Écriture conditionnelle vérifiée sur l'état
   * LU dans la session : sinon exception, donc annulation de la transaction
   * (aucune période sans paiement marqué). Partagé par la confirmation
   * (`finalize`) et le rapprochement opérateur (1-14D.2G).
   */
  async grantAndMarkSucceededInSession(
    session: MongooseSession,
    current: PaymentRecord,
    verified: ProviderPaymentStatus,
  ): Promise<Types.ObjectId> {
    const granted = await this.subscriptions.grantSubscriptionInSession(
      {
        organizationId: current.organizationId.toHexString(),
        term: current.term,
        source: SubscriptionSource.PAYMENT,
        sourceReference: paymentGrantReference(current._id),
        grantedBy: `payment:${current.provider}`,
      },
      session,
    );
    const periodId = new Types.ObjectId(granted.periodId);
    const marked = await this.paymentModel
      .updateOne(
        { _id: current._id, status: current.status, periodId: null },
        {
          $set: {
            status: SubscriptionPaymentStatus.SUCCEEDED,
            open: false,
            periodId,
            providerReference: verified.providerReference,
            ...(typeof verified.providerTransactionId === 'string'
              ? { providerTransactionId: verified.providerTransactionId }
              : {}),
            providerCheckoutUrl: null,
            confirmedAt: this.clock(),
          },
        },
        { session },
      )
      .exec();
    if (marked.modifiedCount !== 1) {
      throw new Error('Subscription payment finalization lost its race');
    }
    return periodId;
  }

  /**
   * Collecte acceptée / en attente : référence prestataire adoptée. Vrai si
   * l'état visible a changé (`pending` ou `review`).
   */
  private async recordPending(
    paymentId: Types.ObjectId,
    providerReference: string,
    from: readonly SubscriptionPaymentStatus[],
    attached: {
      checkoutUrl?: string | null;
      providerTransactionId?: string | null;
    } = {},
  ): Promise<boolean> {
    const before = await this.findById(paymentId);
    const transactionId =
      typeof attached.providerTransactionId === 'string'
        ? attached.providerTransactionId
        : null;
    try {
      const updated = await this.paymentModel
        .updateOne(
          {
            _id: paymentId,
            status: { $in: from },
            providerReference: { $in: [null, providerReference] },
            // 1-21B : une transaction rattachée n'est jamais remplacée.
            ...(transactionId
              ? { providerTransactionId: { $in: [null, transactionId] } }
              : {}),
          },
          {
            $set: {
              status: SubscriptionPaymentStatus.PENDING,
              providerReference,
              initiatedAt: before?.initiatedAt ?? this.clock(),
              incidentCode: null,
              ...(transactionId
                ? { providerTransactionId: transactionId }
                : {}),
              ...(attached.checkoutUrl !== undefined
                ? { providerCheckoutUrl: attached.checkoutUrl }
                : {}),
            },
          },
        )
        .exec();
      if (updated.matchedCount === 1) {
        // Visible seulement si l'état, l'incident ou la page ont changé.
        return (
          before?.status !== SubscriptionPaymentStatus.PENDING ||
          before?.incidentCode !== null ||
          (attached.checkoutUrl !== undefined &&
            before?.providerCheckoutUrl !== attached.checkoutUrl)
        );
      }
    } catch (error) {
      const duplicate = subscriptionPaymentDuplicateKeyIndex(error);
      if (
        duplicate !== 'provider_1_providerReference_1' &&
        duplicate !== 'provider_1_providerTransactionId_1'
      ) {
        throw error;
      }
      return this.markReview(paymentId);
    }
    // Non appliqué : état déjà avancé par une autre confirmation, ou
    // référence prestataire différente déjà enregistrée (anomalie).
    const current = await this.findById(paymentId);
    if (
      current &&
      ((current.providerReference !== null &&
        current.providerReference !== providerReference) ||
        (transactionId !== null &&
          current.providerTransactionId !== null &&
          current.providerTransactionId !== transactionId))
    ) {
      return this.markReview(paymentId);
    }
    return false;
  }

  /**
   * 1-21B — Page de paiement close ou tentative échouée SANS succès
   * constaté : le paiement reste OUVERT (`uncertain`, incident
   * `checkout_unresolved`), toujours vérifiable (succès tardif accepté) ;
   * aucune nouvelle tentative libérée, aucune relance de débit. Clôture par
   * le rapprochement opérateur seulement. Vrai si l'état visible a changé.
   */
  private async recordUnresolved(
    paymentId: Types.ObjectId,
    status: ProviderPaymentStatus,
  ): Promise<boolean> {
    const before = await this.findById(paymentId);
    if (!before) return false;
    const transactionId =
      typeof status.providerTransactionId === 'string'
        ? status.providerTransactionId
        : null;
    try {
      const updated = await this.paymentModel
        .updateOne(
          {
            _id: paymentId,
            status: {
              $in: [
                SubscriptionPaymentStatus.INITIATING,
                SubscriptionPaymentStatus.PENDING,
                SubscriptionPaymentStatus.UNCERTAIN,
              ],
            },
            providerReference: { $in: [null, status.providerReference] },
            ...(transactionId
              ? { providerTransactionId: { $in: [null, transactionId] } }
              : {}),
          },
          {
            $set: {
              status: SubscriptionPaymentStatus.UNCERTAIN,
              incidentCode: SubscriptionPaymentIncident.CHECKOUT_UNRESOLVED,
              providerReference: status.providerReference,
              providerCheckoutUrl: status.checkoutUrl ?? null,
              ...(transactionId
                ? { providerTransactionId: transactionId }
                : {}),
            },
          },
        )
        .exec();
      if (updated.matchedCount !== 1) return false;
    } catch (error) {
      const duplicate = subscriptionPaymentDuplicateKeyIndex(error);
      if (
        duplicate !== 'provider_1_providerReference_1' &&
        duplicate !== 'provider_1_providerTransactionId_1'
      ) {
        throw error;
      }
      return this.markReview(paymentId);
    }
    return (
      before.status !== SubscriptionPaymentStatus.UNCERTAIN ||
      before.incidentCode !== SubscriptionPaymentIncident.CHECKOUT_UNRESOLVED
    );
  }

  /**
   * 1-21B — Paiement auquel une transaction du prestataire est RATTACHÉE
   * (notification) ; `null` sinon. Lecture seule.
   */
  async findByProviderTransaction(
    providerName: string,
    providerTransactionId: string,
  ): Promise<Types.ObjectId | null> {
    const found = await this.paymentModel
      .findOne({ provider: providerName, providerTransactionId })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }>()
      .exec();
    return found?._id ?? null;
  }

  /**
   * 1-21B — Candidats BORNÉS au rattachement d'une transaction notifiée
   * avant d'être connue : paiements ouverts de ce prestataire, session
   * connue, aucune transaction rattachée, initiés depuis `since` ; les plus
   * récents d'abord, au plus `limit`. Jamais tous les paiements ouverts.
   */
  async unattachedCandidates(
    providerName: string,
    since: Date,
    limit: number,
  ): Promise<Types.ObjectId[]> {
    const rows = await this.paymentModel
      .find({
        provider: providerName,
        open: true,
        status: {
          $in: [
            SubscriptionPaymentStatus.PENDING,
            SubscriptionPaymentStatus.UNCERTAIN,
          ],
        },
        providerReference: { $type: 'string' },
        providerTransactionId: null,
        initiatedAt: { $gte: since },
      })
      .sort({ initiatedAt: -1 })
      .limit(limit)
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    return rows.map((r) => r._id);
  }

  /**
   * Refus CONFIRMÉ : ferme un paiement ouvert. Jamais de régression d'un
   * `succeeded` (réponse tardive ou désordonnée) : incident consigné (absent
   * de la vue). Vrai seulement si le paiement est passé à `failed`.
   */
  private async recordFailure(
    paymentId: Types.ObjectId,
    providerReference: string,
  ): Promise<boolean> {
    const updated = await this.paymentModel
      .updateOne(
        {
          _id: paymentId,
          status: { $in: OPEN_PAYMENT_STATUSES },
          providerReference: { $in: [null, providerReference] },
        },
        {
          $set: {
            status: SubscriptionPaymentStatus.FAILED,
            open: false,
            providerReference,
            failedAt: this.clock(),
          },
        },
      )
      .exec();
    if (updated.matchedCount === 1) return true;
    await this.paymentModel
      .updateOne(
        {
          _id: paymentId,
          status: SubscriptionPaymentStatus.SUCCEEDED,
          incidentCode: null,
        },
        {
          $set: {
            incidentCode:
              SubscriptionPaymentIncident.LATE_FAILURE_AFTER_SUCCESS,
          },
        },
      )
      .exec();
    return false;
  }

  /**
   * Discordance : `review`, `open` conservé ; jamais depuis `succeeded`.
   * Vrai si le paiement est passé à `review`.
   */
  private async markReview(
    paymentId: Types.ObjectId,
    incident: SubscriptionPaymentIncident = SubscriptionPaymentIncident.PROVIDER_MISMATCH,
  ): Promise<boolean> {
    return this.transition(paymentId, FINALIZABLE_STATUSES, {
      status: SubscriptionPaymentStatus.REVIEW,
      incidentCode: incident,
    });
  }

  private async transition(
    paymentId: Types.ObjectId,
    from: readonly SubscriptionPaymentStatus[],
    set: Partial<SubscriptionPayment>,
  ): Promise<boolean> {
    const updated = await this.paymentModel
      .updateOne({ _id: paymentId, status: { $in: from } }, { $set: set })
      .exec();
    return updated.matchedCount === 1;
  }

  /** 1-15F : best effort, jamais d'exception (voir le service de signaux). */
  private signalPayments(organizationId: Types.ObjectId): void {
    void this.signals.paymentsChanged(organizationId.toHexString());
  }

  private replay(
    existing: PaymentRecord,
    requestedBy: Types.ObjectId,
    fingerprint: string,
  ): { payment: SubscriptionPaymentView; replayed: boolean } {
    if (
      !existing.requestedBy.equals(requestedBy) ||
      existing.requestFingerprint !== fingerprint
    ) {
      throw paymentOperationConflict();
    }
    return { payment: this.toView(existing), replayed: true };
  }

  private findOperation(
    organizationId: Types.ObjectId,
    clientOperationId: string,
  ): Promise<PaymentRecord | null> {
    return this.paymentModel
      .findOne({ organizationId, clientOperationId })
      .lean<PaymentRecord>()
      .exec();
  }

  private findById(paymentId: Types.ObjectId): Promise<PaymentRecord | null> {
    return this.paymentModel.findById(paymentId).lean<PaymentRecord>().exec();
  }

  /** 404 UNIFORME : id invalide, inexistant ou d'une autre organisation. */
  private async findScoped(
    context: PaymentRequestContext,
    paymentId: string,
  ): Promise<PaymentRecord> {
    if (!isStrictObjectId(paymentId)) throw paymentNotFound();
    const payment = await this.paymentModel
      .findOne({
        _id: new Types.ObjectId(paymentId),
        organizationId: new Types.ObjectId(context.organizationId),
      })
      .lean<PaymentRecord>()
      .exec();
    if (!payment) throw paymentNotFound();
    return payment;
  }

  private async viewById(
    paymentId: Types.ObjectId,
  ): Promise<SubscriptionPaymentView> {
    const payment = await this.findById(paymentId);
    if (!payment) throw paymentNotFound();
    return this.toView(payment);
  }

  private toView(payment: PaymentRecord): SubscriptionPaymentView {
    return {
      paymentId: payment._id.toHexString(),
      reference: payment.merchantReference,
      status: payment.status,
      term: payment.term,
      amount: payment.amount,
      currency: payment.currency,
      payerPhoneMasked: payment.payerPhoneMasked ?? null,
      checkoutUrl: payment.open ? (payment.providerCheckoutUrl ?? null) : null,
      createdAt: iso(payment.createdAt),
      initiatedAt: iso(payment.initiatedAt),
      confirmedAt: iso(payment.confirmedAt),
      failedAt: iso(payment.failedAt),
    };
  }
}
