import { createHash } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Model, Types } from 'mongoose';
import {
  SubscriptionGrantError,
  SubscriptionsService,
} from '../../subscriptions.service';
import { SUBSCRIPTION_CLOCK } from '../../subscription-clock';
import type { SubscriptionClock } from '../../subscription-clock';
import {
  SubscriptionPayment,
  SubscriptionPaymentDocument,
  SubscriptionPaymentStatus,
} from '../schemas/subscription-payment.schema';
import { PAYMENT_PROVIDER } from '../payment-provider';
import type {
  PaymentProvider,
  ProviderPaymentStatus,
} from '../payment-provider';
import {
  ConcordanceField,
  paymentConcordanceMismatches,
} from '../payment-concordance';
import {
  PAYMENT_CONFIRMATION_BUDGET_MS,
  PaymentRecord,
  SubscriptionPaymentsService,
} from '../subscription-payments.service';
import {
  subscriptionPaymentDuplicateKeyIndex,
  verifySubscriptionPaymentIndexes,
} from '../subscription-payment-indexes';
import {
  ReconciliationAction,
  ReconciliationReason,
  SubscriptionPaymentReconciliation,
  SubscriptionPaymentReconciliationDocument,
} from './subscription-payment-reconciliation.schema';
import {
  isReconciliationOperationDuplicate,
  verifyReconciliationIndexes,
} from './subscription-payment-reconciliation-indexes';

/**
 * 1-14D.2G — Rapprochement OPÉRATEUR d'un paiement `uncertain` ou `review`.
 *
 * Accès : CLI uniquement (aucune route HTTP, aucun droit propriétaire).
 * L'autorisation repose sur l'accès privilégié à l'environnement d'exécution
 * (base de production, secrets) ; l'identifiant opérateur sert à l'AUDIT.
 *
 * Règles :
 * - la référence CamPay consultée est la référence PERSISTÉE, sinon une
 *   référence CANDIDATE fournie par l'opérateur (simple indice) ; une
 *   référence persistée n'est jamais remplacée ; une candidate déjà portée
 *   par un autre paiement est refusée ;
 * - consultation UNIQUEMENT par référence prestataire (`fetchStatus`), HORS
 *   transaction, avec le budget HTTP de l'adaptateur ; aucune recherche par
 *   référence marchand, aucun autre endpoint, aucune initiation ;
 * - concordance EXACTE (référence CamPay = consultée, référence marchand,
 *   montant entier validé lexicalement, devise) : sinon AUCUNE mutation, état
 *   et référence conservés — même pour un paiement `review` ;
 * - action DÉDUITE du statut vérifié : `succeeded` → attribution
 *   `source: payment` (`payment:<id>`) + `succeeded` via la fonction du
 *   moteur unique ; `pending` → paiement ouvert `pending` ; `failed` →
 *   fermeture `failed` ;
 * - simulation par défaut ; `apply` relit le paiement, reconsulte le
 *   prestataire et exige le MÊME plan (jeton) : sinon `PLAN_STALE` ;
 * - mutation, rattachement, période et audit dans UNE transaction (budget
 *   de 30 s), identifiant d'opération idempotent.
 * Fournisseur injecté (`PAYMENT_PROVIDER`) : avec `UnavailablePaymentProvider`
 * (production), aucune consultation ni mutation n'est possible.
 */

export const RECONCILABLE_STATUSES: readonly SubscriptionPaymentStatus[] =
  Object.freeze([
    SubscriptionPaymentStatus.UNCERTAIN,
    SubscriptionPaymentStatus.REVIEW,
  ]);

export type ReconciliationBlockReason =
  | 'status-not-reconcilable'
  | 'closed-review-cannot-reopen'
  | 'provider-unavailable'
  | 'reference-required'
  | 'reference-differs-from-persisted'
  | 'reference-already-attached'
  | 'provider-status-unavailable'
  | 'provider-transaction-not-found'
  | 'mismatch';

/** Faits VÉRIFIÉS exposés (normalisés) ; jamais la réponse brute. */
export interface VerifiedFacts {
  state: ProviderPaymentStatus['state'];
  providerReference: string | null;
  merchantReference: string | null;
  amount: number | null;
  currency: string | null;
}

export interface PlanBefore {
  status: SubscriptionPaymentStatus;
  open: boolean;
  providerReference: string | null;
}

export type ReconciliationPlan =
  | {
      decision: 'blocked';
      reason: ReconciliationBlockReason;
      paymentId: string;
      before: PlanBefore;
      consultedReference: string | null;
      verified: VerifiedFacts | null;
      mismatches: ConcordanceField[];
    }
  | {
      decision: 'ready';
      action: ReconciliationAction;
      paymentId: string;
      before: PlanBefore;
      consultedReference: string;
      referenceAttach: boolean;
      verified: VerifiedFacts;
      after: {
        status: SubscriptionPaymentStatus;
        open: boolean;
        grantsPeriod: boolean;
      };
      planToken: string;
    };

export interface ReconciliationOperation {
  operationId: string;
  operatorId: string;
  reasonCode: ReconciliationReason;
  reasonTicket: string | null;
  planToken: string;
}

export interface AppliedReconciliation {
  result: 'applied' | 'replayed';
  operationId: string;
  paymentId: string;
  action: ReconciliationAction;
  consultedReference: string;
  referenceAttached: boolean;
  before: {
    status: SubscriptionPaymentStatus;
    providerReference: string | null;
  };
  after: {
    status: SubscriptionPaymentStatus;
    providerReference: string;
    periodId: string | null;
  };
  appliedAt: string;
}

export type ReconciliationErrorCode =
  | 'PAYMENT_NOT_FOUND'
  | 'INVALID_REFERENCE'
  | 'PLAN_STALE'
  | 'OPERATION_CONFLICT'
  | 'CONFIRMATION_PENDING';

export class ReconciliationError extends Error {
  constructor(
    readonly code: ReconciliationErrorCode,
    message: string,
    readonly currentPlan: ReconciliationPlan | null = null,
  ) {
    super(message);
    this.name = 'ReconciliationError';
  }
}

export interface PaymentInspection {
  paymentId: string;
  organizationId: string;
  provider: string;
  status: SubscriptionPaymentStatus;
  open: boolean;
  reconcilable: boolean;
  term: string;
  amount: number;
  currency: string;
  merchantReference: string;
  providerReference: string | null;
  incidentCode: string | null;
  periodId: string | null;
  createdAt: string | null;
  initiatedAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
  lastCheckedAt: string | null;
  reconciliations: {
    operationId: string;
    operatorId: string;
    reasonCode: ReconciliationReason;
    reasonTicket: string | null;
    action: ReconciliationAction;
    beforeStatus: SubscriptionPaymentStatus;
    afterStatus: SubscriptionPaymentStatus;
    consultedReference: string;
    referenceAttached: boolean;
    appliedAt: string;
  }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isStrictObjectId = (value: string) => /^[0-9a-fA-F]{24}$/.test(value);
const iso = (date: Date | null | undefined) =>
  date ? date.toISOString() : null;

type ReconciliationRecord = SubscriptionPaymentReconciliation & {
  _id: Types.ObjectId;
};

/** Plan interne : conserve le statut vérifié complet (jamais exposé brut). */
type InternalPlan =
  | { plan: Extract<ReconciliationPlan, { decision: 'blocked' }> }
  | {
      plan: Extract<ReconciliationPlan, { decision: 'ready' }>;
      status: ProviderPaymentStatus;
    };

const ACTION_BY_STATE: Readonly<
  Record<ProviderPaymentStatus['state'], ReconciliationAction>
> = Object.freeze({
  succeeded: ReconciliationAction.SUCCEED,
  pending: ReconciliationAction.MARK_PENDING,
  failed: ReconciliationAction.FAIL,
});

function facts(status: ProviderPaymentStatus): VerifiedFacts {
  return {
    state: status.state,
    providerReference:
      typeof status.providerReference === 'string'
        ? status.providerReference
        : null,
    merchantReference:
      typeof status.merchantReference === 'string'
        ? status.merchantReference
        : null,
    amount:
      typeof status.amount === 'number' && Number.isSafeInteger(status.amount)
        ? status.amount
        : null,
    currency: typeof status.currency === 'string' ? status.currency : null,
  };
}

const sha256 = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

@Injectable()
export class PaymentReconciliationService {
  constructor(
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPaymentDocument>,
    @InjectModel(SubscriptionPaymentReconciliation.name)
    private readonly reconciliationModel: Model<SubscriptionPaymentReconciliationDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly subscriptions: SubscriptionsService,
    private readonly payments: SubscriptionPaymentsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(SUBSCRIPTION_CLOCK) private readonly clock: SubscriptionClock,
  ) {}

  /** Normalise une référence candidate (UUID, minuscules) ; sinon erreur. */
  static normalizeReference(reference: string | null): string | null {
    if (reference === null) return null;
    if (!UUID.test(reference)) {
      throw new ReconciliationError(
        'INVALID_REFERENCE',
        'Référence CamPay invalide (UUID attendu).',
      );
    }
    return reference.toLowerCase();
  }

  // ─── Inspection (locale, aucun réseau) ─────────────────────────────────────

  async inspect(paymentId: string): Promise<PaymentInspection> {
    const payment = await this.load(paymentId);
    const history = await this.reconciliationModel
      .find({ paymentId: payment._id })
      .sort({ _id: 1 })
      .lean<ReconciliationRecord[]>()
      .exec();
    return {
      paymentId: payment._id.toHexString(),
      organizationId: payment.organizationId.toHexString(),
      provider: payment.provider,
      status: payment.status,
      open: payment.open,
      reconcilable: RECONCILABLE_STATUSES.includes(payment.status),
      term: payment.term,
      amount: payment.amount,
      currency: payment.currency,
      merchantReference: payment.merchantReference,
      providerReference: payment.providerReference ?? null,
      incidentCode: payment.incidentCode ?? null,
      periodId: payment.periodId ? payment.periodId.toHexString() : null,
      createdAt: iso(payment.createdAt),
      initiatedAt: iso(payment.initiatedAt),
      confirmedAt: iso(payment.confirmedAt),
      failedAt: iso(payment.failedAt),
      lastCheckedAt: iso(payment.lastCheckedAt),
      reconciliations: history.map((r) => ({
        operationId: r.operationId,
        operatorId: r.operatorId,
        reasonCode: r.reasonCode,
        reasonTicket: r.reasonTicket ?? null,
        action: r.action,
        beforeStatus: r.beforeStatus,
        afterStatus: r.afterStatus,
        consultedReference: r.consultedReference,
        referenceAttached: r.referenceAttached,
        appliedAt: r.appliedAt.toISOString(),
      })),
    };
  }

  // ─── Simulation (consultation en lecture, aucune écriture) ─────────────────

  async plan(
    paymentId: string,
    candidateReference: string | null,
  ): Promise<ReconciliationPlan> {
    return (await this.buildPlan(paymentId, candidateReference)).plan;
  }

  // ─── Application ───────────────────────────────────────────────────────────

  async apply(
    paymentId: string,
    candidateReference: string | null,
    operation: ReconciliationOperation,
  ): Promise<AppliedReconciliation | ReconciliationPlan> {
    // Index requis AVANT toute mutation (aucune création automatique).
    await verifySubscriptionPaymentIndexes(this.connection);
    await verifyReconciliationIndexes(this.connection);

    const candidate =
      PaymentReconciliationService.normalizeReference(candidateReference);
    const fingerprint = sha256([
      'reconciliation-v1',
      paymentId.toLowerCase(),
      candidate,
      operation.operatorId,
      operation.reasonCode,
      operation.reasonTicket,
      operation.planToken,
    ]);

    // 1. Rejeu AVANT tout réseau : même identifiant → même résultat.
    const previous = await this.findOperation(operation.operationId);
    if (previous) return this.replay(previous, fingerprint);

    // 2. Plan RECALCULÉ (relecture + reconsultation) ; jeton identique exigé.
    const built = await this.buildPlan(paymentId, candidate);
    if (!('status' in built)) return built.plan;
    if (built.plan.planToken !== operation.planToken) {
      throw new ReconciliationError(
        'PLAN_STALE',
        'Plan obsolète : le paiement ou le statut vérifié a changé. Aucune mutation.',
        built.plan,
      );
    }
    const { plan, status } = built;

    // 3. Mutation + audit dans UNE transaction (aucun réseau).
    let outcome:
      | { kind: 'applied'; record: ReconciliationRecord }
      | { kind: 'replay'; record: ReconciliationRecord }
      | { kind: 'stale' };
    try {
      outcome = await this.subscriptions.runInGrantTransaction(
        async (session) => {
          const already = await this.reconciliationModel
            .findOne({ operationId: operation.operationId })
            .session(session)
            .lean<ReconciliationRecord>()
            .exec();
          if (already) return { kind: 'replay' as const, record: already };

          const current = await this.paymentModel
            .findById(plan.paymentId)
            .session(session)
            .lean<PaymentRecord>()
            .exec();
          // Préconditions du plan revérifiées DANS la session.
          if (
            !current ||
            current.status !== plan.before.status ||
            current.open !== plan.before.open ||
            (current.providerReference ?? null) !==
              plan.before.providerReference ||
            (current.periodId ?? null) !== null ||
            paymentConcordanceMismatches(
              current,
              status,
              plan.consultedReference,
            ).length > 0
          ) {
            return { kind: 'stale' as const };
          }

          const now = this.clock();
          let periodId: Types.ObjectId | null = null;
          if (plan.action === ReconciliationAction.SUCCEED) {
            periodId = await this.payments.grantAndMarkSucceededInSession(
              session,
              current,
              status,
            );
          } else {
            const set =
              plan.action === ReconciliationAction.MARK_PENDING
                ? {
                    status: SubscriptionPaymentStatus.PENDING,
                    providerReference: plan.consultedReference,
                    incidentCode: null,
                    initiatedAt: current.initiatedAt ?? now,
                    lastCheckedAt: now,
                  }
                : {
                    status: SubscriptionPaymentStatus.FAILED,
                    open: false,
                    providerReference: plan.consultedReference,
                    failedAt: now,
                    lastCheckedAt: now,
                  };
            const updated = await this.paymentModel
              .updateOne(
                {
                  _id: current._id,
                  status: current.status,
                  providerReference: current.providerReference ?? null,
                  periodId: null,
                },
                { $set: set },
                { session },
              )
              .exec();
            if (updated.modifiedCount !== 1) {
              throw new Error('Reconciliation lost its race');
            }
          }

          const [record] = await this.reconciliationModel.create(
            [
              {
                operationId: operation.operationId,
                requestFingerprint: fingerprint,
                operatorId: operation.operatorId,
                reasonCode: operation.reasonCode,
                reasonTicket: operation.reasonTicket,
                paymentId: current._id,
                organizationId: current.organizationId,
                planToken: plan.planToken,
                action: plan.action,
                consultedReference: plan.consultedReference,
                referenceAttached: plan.referenceAttach,
                beforeStatus: current.status,
                beforeProviderReference: current.providerReference ?? null,
                afterStatus: plan.after.status,
                afterProviderReference: plan.consultedReference,
                afterPeriodId: periodId,
                verifiedState: status.state,
                // Égalités revérifiées ci-dessus dans la session.
                verifiedProviderReference: plan.consultedReference,
                verifiedMerchantReference: current.merchantReference,
                verifiedAmount: current.amount,
                verifiedCurrency: current.currency,
                result: 'applied',
                appliedAt: now,
              },
            ],
            { session },
          );
          return {
            kind: 'applied' as const,
            record: record.toObject(),
          };
        },
        { budgetMs: PAYMENT_CONFIRMATION_BUDGET_MS },
      );
    } catch (error) {
      if (
        error instanceof SubscriptionGrantError &&
        (error.code === 'GRANT_TIMEOUT' || error.code === 'GRANT_CONTENTION')
      ) {
        // Résultat de commit INCONNU : rejouer avec le MÊME identifiant
        // retrouve un commit validé (audit), sans seconde période.
        throw new ReconciliationError(
          'CONFIRMATION_PENDING',
          'Rapprochement non confirmé dans le délai : rejouer la même opération.',
        );
      }
      if (isReconciliationOperationDuplicate(error)) {
        const concurrent = await this.findOperation(operation.operationId);
        if (concurrent) return this.replay(concurrent, fingerprint);
      }
      if (
        subscriptionPaymentDuplicateKeyIndex(error) ===
        'provider_1_providerReference_1'
      ) {
        // Référence rattachée à un autre paiement entre-temps : rollback
        // complet (ni rattachement, ni audit, ni période).
        return {
          decision: 'blocked',
          reason: 'reference-already-attached',
          paymentId: plan.paymentId,
          before: plan.before,
          consultedReference: plan.consultedReference,
          verified: plan.verified,
          mismatches: [],
        };
      }
      throw error;
    }

    if (outcome.kind === 'replay')
      return this.replay(outcome.record, fingerprint);
    if (outcome.kind === 'stale') {
      throw new ReconciliationError(
        'PLAN_STALE',
        'Plan obsolète : le paiement a changé pendant l’application. Aucune mutation.',
        (await this.buildPlan(paymentId, candidate).catch(() => null))?.plan ??
          null,
      );
    }
    return this.toApplied(outcome.record, 'applied');
  }

  // ─── Internes ──────────────────────────────────────────────────────────────

  private async load(paymentId: string): Promise<PaymentRecord> {
    const payment = isStrictObjectId(paymentId)
      ? await this.paymentModel
          .findById(new Types.ObjectId(paymentId))
          .lean<PaymentRecord>()
          .exec()
      : null;
    if (!payment) {
      throw new ReconciliationError(
        'PAYMENT_NOT_FOUND',
        'Paiement introuvable.',
      );
    }
    return payment;
  }

  private async buildPlan(
    paymentId: string,
    candidateReference: string | null,
  ): Promise<InternalPlan> {
    const candidate =
      PaymentReconciliationService.normalizeReference(candidateReference);
    const payment = await this.load(paymentId);
    const before: PlanBefore = {
      status: payment.status,
      open: payment.open,
      providerReference: payment.providerReference ?? null,
    };
    const blocked = (
      reason: ReconciliationBlockReason,
      consultedReference: string | null = null,
      verified: VerifiedFacts | null = null,
      mismatches: ConcordanceField[] = [],
    ): InternalPlan => ({
      plan: {
        decision: 'blocked',
        reason,
        paymentId: payment._id.toHexString(),
        before,
        consultedReference,
        verified,
        mismatches,
      },
    });

    if (!RECONCILABLE_STATUSES.includes(payment.status)) {
      return blocked('status-not-reconcilable');
    }
    if (!this.provider.available || payment.provider !== this.provider.name) {
      return blocked('provider-unavailable');
    }
    const persisted = payment.providerReference ?? null;
    if (persisted !== null && candidate !== null && candidate !== persisted) {
      return blocked('reference-differs-from-persisted', persisted);
    }
    const reference = persisted ?? candidate;
    if (reference === null) return blocked('reference-required');
    if (persisted === null) {
      const holder = await this.paymentModel
        .findOne({
          provider: payment.provider,
          providerReference: reference,
          _id: { $ne: payment._id },
        })
        .select({ _id: 1 })
        .lean()
        .exec();
      if (holder) return blocked('reference-already-attached', reference);
    }

    // Consultation HORS transaction (budget HTTP de l'adaptateur).
    let status: ProviderPaymentStatus | null;
    try {
      status = await this.provider.fetchStatus({
        by: 'provider',
        providerReference: reference,
      });
    } catch {
      return blocked('provider-status-unavailable', reference);
    }
    if (!status) return blocked('provider-transaction-not-found', reference);

    const verified = facts(status);
    const mismatches = paymentConcordanceMismatches(payment, status, reference);
    if (mismatches.length > 0) {
      return blocked('mismatch', reference, verified, mismatches);
    }

    const action = ACTION_BY_STATE[status.state];
    if (action === ReconciliationAction.MARK_PENDING && !payment.open) {
      // `review` issu d'un paiement fermé : jamais de réouverture (index du
      // paiement ouvert unique), traitement hors de ce CLI.
      return blocked('closed-review-cannot-reopen', reference, verified);
    }
    const after = {
      status:
        action === ReconciliationAction.SUCCEED
          ? SubscriptionPaymentStatus.SUCCEEDED
          : action === ReconciliationAction.FAIL
            ? SubscriptionPaymentStatus.FAILED
            : SubscriptionPaymentStatus.PENDING,
      open: action === ReconciliationAction.MARK_PENDING,
      grantsPeriod: action === ReconciliationAction.SUCCEED,
    };
    const paymentKey = payment._id.toHexString();
    const planToken = sha256([
      'reconciliation-plan-v1',
      paymentKey,
      before,
      reference,
      action,
      verified,
    ]).slice(0, 32);
    return {
      plan: {
        decision: 'ready',
        action,
        paymentId: paymentKey,
        before,
        consultedReference: reference,
        referenceAttach: persisted === null,
        verified,
        after,
        planToken,
      },
      status,
    };
  }

  private findOperation(
    operationId: string,
  ): Promise<ReconciliationRecord | null> {
    return this.reconciliationModel
      .findOne({ operationId })
      .lean<ReconciliationRecord>()
      .exec();
  }

  private replay(
    record: ReconciliationRecord,
    fingerprint: string,
  ): AppliedReconciliation {
    if (record.requestFingerprint !== fingerprint) {
      throw new ReconciliationError(
        'OPERATION_CONFLICT',
        'Identifiant d’opération déjà utilisé avec d’autres paramètres. Aucune mutation.',
      );
    }
    return this.toApplied(record, 'replayed');
  }

  private toApplied(
    record: ReconciliationRecord,
    result: 'applied' | 'replayed',
  ): AppliedReconciliation {
    return {
      result,
      operationId: record.operationId,
      paymentId: record.paymentId.toHexString(),
      action: record.action,
      consultedReference: record.consultedReference,
      referenceAttached: record.referenceAttached,
      before: {
        status: record.beforeStatus,
        providerReference: record.beforeProviderReference ?? null,
      },
      after: {
        status: record.afterStatus,
        providerReference: record.afterProviderReference,
        periodId: record.afterPeriodId
          ? record.afterPeriodId.toHexString()
          : null,
      },
      appliedAt: record.appliedAt.toISOString(),
    };
  }
}
