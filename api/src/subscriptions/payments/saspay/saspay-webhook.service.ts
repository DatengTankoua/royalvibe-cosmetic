import { Inject, Injectable } from '@nestjs/common';
import { SubscriptionPaymentsService } from '../subscription-payments.service';
import { SASPAY_PROVIDER_NAME } from './saspay-config';
import { verifySasPayWebhookSignature } from './saspay-webhook-signature';

/**
 * 1-21B — Configuration du webhook SasPay. Désactivé par défaut (503 sans
 * lecture) ; activé seulement par le module quand `SASPAY_WEBHOOK_SECRET`
 * est configuré.
 */
export const SASPAY_WEBHOOK_CONFIG = Symbol('SASPAY_WEBHOOK_CONFIG');

export type SasPayWebhookConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly secret: string;
      /** Horloge murale (ms) ; `Date.now` par défaut. */
      readonly now?: () => number;
    };

export const DISABLED_SASPAY_WEBHOOK: SasPayWebhookConfig = Object.freeze({
  enabled: false,
});

export const SASPAY_WEBHOOK_CODES = Object.freeze({
  DISABLED: 'PAYMENT_WEBHOOK_DISABLED',
  INVALID: 'PAYMENT_WEBHOOK_INVALID',
  TOO_LARGE: 'PAYMENT_WEBHOOK_TOO_LARGE',
  UNAUTHORIZED: 'PAYMENT_WEBHOOK_UNAUTHORIZED',
  RETRY_LATER: 'PAYMENT_WEBHOOK_RETRY_LATER',
} as const);

export const SASPAY_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
export const SASPAY_WEBHOOK_RETRY_AFTER_SECONDS = 60;
/**
 * Rattachement d'une transaction notifiée AVANT d'être connue : au plus
 * 3 paiements candidats (ouverts, session connue, sans transaction, initiés
 * depuis 24 h), dans un budget de 10 s (SasPay coupe à 15 s).
 */
export const SASPAY_WEBHOOK_MAX_CANDIDATES = 3;
export const SASPAY_WEBHOOK_CANDIDATE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SASPAY_WEBHOOK_BUDGET_MS = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSACTION_EVENTS = new Set([
  'transaction.created',
  'transaction.success',
  'transaction.failed',
  'transaction.cancelled',
]);

export interface SasPayWebhookRequest {
  rawBody: Buffer | undefined;
  contentType: string | undefined;
  signature: unknown;
  timestamp: unknown;
  eventHeader: unknown;
}

export interface SasPayWebhookResponse {
  status: number;
  body: Record<string, unknown>;
  retryAfterSeconds?: number;
}

const ACK: SasPayWebhookResponse = { status: 200, body: { received: true } };
const refusal = (
  status: number,
  code: string,
  message: string,
): SasPayWebhookResponse => ({
  status,
  body: { statusCode: status, code, message },
});
const RESPONSES = Object.freeze({
  disabled: refusal(
    503,
    SASPAY_WEBHOOK_CODES.DISABLED,
    'Notifications de paiement désactivées.',
  ),
  invalid: refusal(
    400,
    SASPAY_WEBHOOK_CODES.INVALID,
    'Notification de paiement invalide.',
  ),
  tooLarge: refusal(
    413,
    SASPAY_WEBHOOK_CODES.TOO_LARGE,
    'Notification de paiement trop volumineuse.',
  ),
  unauthorized: refusal(
    401,
    SASPAY_WEBHOOK_CODES.UNAUTHORIZED,
    'Notification de paiement non authentifiée.',
  ),
  retryLater: {
    ...refusal(
      503,
      SASPAY_WEBHOOK_CODES.RETRY_LATER,
      'Notification non traitée pour le moment. Réessayez plus tard.',
    ),
    retryAfterSeconds: SASPAY_WEBHOOK_RETRY_AFTER_SECONDS,
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 1-21B — Notification SasPay = DÉCLENCHEUR de vérification serveur.
 *
 * 1. Désactivé → 503 sans lecture. Corps brut absent, non JSON ou trop
 *    volumineux → 400 / 413. Signature ou horodatage invalides → 401.
 * 2. Événements hors `transaction.*` (test, retraits, transferts) ou
 *    transaction hors paiement (`type` ≠ `PAIEMENT`) → accusé, rien.
 * 3. Transaction déjà RATTACHÉE à un paiement → `confirmPayment` : statut
 *    RELU chez SasPay, concordance, attribution atomique. Le contenu de la
 *    notification (statut, montants) n'est JAMAIS une preuve.
 * 4. Transaction inconnue : rapprochement BORNÉ (au plus 3 paiements
 *    candidats récents, sans transaction rattachée) ; chaque vérification
 *    rattache la transaction que SA session désigne. Rattachée → accusé.
 *    Aucun candidat → accusé (transaction étrangère aux abonnements).
 * 5. Sinon (candidats sans rattachement, erreur temporaire, budget épuisé)
 *    → 503 : SasPay renvoie la notification (30 s, 5 min, 30 min, 2 h) ; le
 *    bouton « Vérifier », le retour du payeur et le CLI restent disponibles.
 * Aucun balayage de tous les paiements ouverts ; aucune journalisation du
 * contenu ; réponses génériques.
 */
@Injectable()
export class SasPayWebhookService {
  constructor(
    @Inject(SASPAY_WEBHOOK_CONFIG) private readonly config: SasPayWebhookConfig,
    private readonly payments: SubscriptionPaymentsService,
  ) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  async handle(request: SasPayWebhookRequest): Promise<SasPayWebhookResponse> {
    const config = this.config;
    if (!config.enabled) return RESPONSES.disabled;

    const raw = request.rawBody;
    if (!raw || raw.length === 0) return RESPONSES.invalid;
    if (raw.length > SASPAY_WEBHOOK_MAX_BODY_BYTES) return RESPONSES.tooLarge;
    if (
      typeof request.contentType !== 'string' ||
      !request.contentType.toLowerCase().startsWith('application/json')
    ) {
      return RESPONSES.invalid;
    }
    const now = (config.now ?? Date.now)();
    const check = verifySasPayWebhookSignature({
      rawBody: raw,
      signature: request.signature,
      timestamp: request.timestamp,
      secret: config.secret,
      nowMs: now,
    });
    if (check !== 'valid') return RESPONSES.unauthorized;

    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      return RESPONSES.invalid;
    }
    if (!isRecord(body) || typeof body.event !== 'string') {
      return RESPONSES.invalid;
    }
    if (
      request.eventHeader !== undefined &&
      request.eventHeader !== body.event
    ) {
      return RESPONSES.invalid;
    }
    if (!TRANSACTION_EVENTS.has(body.event)) return ACK;
    const data = body.data;
    if (!isRecord(data) || typeof data.id !== 'string' || !UUID.test(data.id)) {
      return RESPONSES.invalid;
    }
    if (data.type !== undefined && data.type !== 'PAIEMENT') return ACK;
    const transactionId = data.id.toLowerCase();

    const deadline = Date.now() + SASPAY_WEBHOOK_BUDGET_MS;
    try {
      const attached = await this.payments.findByProviderTransaction(
        SASPAY_PROVIDER_NAME,
        transactionId,
      );
      if (attached) {
        await this.withinBudget(
          this.payments.confirmPaymentShared(attached),
          deadline,
        );
        return ACK;
      }
      const candidates = await this.payments.unattachedCandidates(
        SASPAY_PROVIDER_NAME,
        new Date(now - SASPAY_WEBHOOK_CANDIDATE_WINDOW_MS),
        SASPAY_WEBHOOK_MAX_CANDIDATES,
      );
      if (candidates.length === 0) return ACK;
      for (const candidate of candidates) {
        await this.withinBudget(
          this.payments.confirmPaymentShared(candidate),
          deadline,
        ).catch(() => undefined);
        const found = await this.payments.findByProviderTransaction(
          SASPAY_PROVIDER_NAME,
          transactionId,
        );
        if (found) return ACK;
        if (Date.now() >= deadline) break;
      }
      return RESPONSES.retryLater;
    } catch {
      // Statut indisponible, contention, budget épuisé ou base indisponible :
      // TEMPORAIRE ; l'état du paiement est conservé (jamais `failed`).
      return RESPONSES.retryLater;
    }
  }

  private withinBudget<T>(work: Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new Error('budget'));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('budget')), remaining);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }
}
