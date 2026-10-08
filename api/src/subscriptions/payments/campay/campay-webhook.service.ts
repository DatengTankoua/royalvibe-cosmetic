import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SubscriptionPaymentsService } from '../subscription-payments.service';
import { CAMPAY_PROVIDER_NAME } from './campay-provider-name';
import {
  CAMPAY_WEBHOOK_CONFIG,
  assertUsableWebhookKey,
} from './campay-webhook.config';
import type { CamPayWebhookConfig } from './campay-webhook.config';
import {
  CamPayWebhookRequest,
  parseCamPayWebhookRequest,
} from './campay-webhook-payload';
import {
  matchSignedNotificationFields,
  verifyCamPayWebhookSignature,
} from './campay-webhook-signature';

/** Codes STABLES du webhook (aucune donnée reçue n'est jamais renvoyée). */
export const CAMPAY_WEBHOOK_CODES = Object.freeze({
  DISABLED: 'PAYMENT_WEBHOOK_DISABLED',
  INVALID: 'PAYMENT_WEBHOOK_INVALID',
  TOO_LARGE: 'PAYMENT_WEBHOOK_TOO_LARGE',
  UNAUTHORIZED: 'PAYMENT_WEBHOOK_UNAUTHORIZED',
  RETRY_LATER: 'PAYMENT_WEBHOOK_RETRY_LATER',
  RATE_LIMITED: 'PAYMENT_WEBHOOK_RATE_LIMITED',
} as const);

/** Délai suggéré (s) des réponses temporaires — choix local, non contractuel. */
export const CAMPAY_WEBHOOK_RETRY_AFTER_SECONDS = 60;

export interface CamPayWebhookResponse {
  status: number;
  body: Record<string, unknown>;
  retryAfterSeconds?: number;
}

const ACK: CamPayWebhookResponse = { status: 200, body: { received: true } };

const refusal = (
  status: number,
  code: string,
  message: string,
): CamPayWebhookResponse => ({
  status,
  body: { statusCode: status, code, message },
});

const RESPONSES = Object.freeze({
  disabled: refusal(
    503,
    CAMPAY_WEBHOOK_CODES.DISABLED,
    'Notifications de paiement désactivées.',
  ),
  invalid: refusal(
    400,
    CAMPAY_WEBHOOK_CODES.INVALID,
    'Notification de paiement invalide.',
  ),
  tooLarge: refusal(
    413,
    CAMPAY_WEBHOOK_CODES.TOO_LARGE,
    'Notification de paiement trop volumineuse.',
  ),
  unauthorized: refusal(
    401,
    CAMPAY_WEBHOOK_CODES.UNAUTHORIZED,
    'Notification de paiement non authentifiée.',
  ),
  retryLater: {
    ...refusal(
      503,
      CAMPAY_WEBHOOK_CODES.RETRY_LATER,
      'Notification non traitée pour le moment. Réessayez plus tard.',
    ),
    retryAfterSeconds: CAMPAY_WEBHOOK_RETRY_AFTER_SECONDS,
  },
});

/**
 * 1-14D.2F — Notification CamPay = DÉCLENCHEUR de vérification.
 *
 * 1. Désactivé (défaut de production) → 503, sans lecture des paramètres,
 *    sans base, sans prestataire.
 * 2. Paramètres stricts (taille, ambiguïté, types) → 400 / 413.
 * 3. Signature HS256 vérifiée avec la clé webhook, puis concordance des
 *    claims signés avec les paramètres reçus → 401 sinon.
 * 4. `endpoint` autre que `collect` (retraits : non utilisés) → accusé, rien.
 * 5. Paiement EXISTANT retrouvé par sa référence CamPay PERSISTÉE →
 *    `confirmPayment` (moteur unique 1-14D.2B : statut RELU chez CamPay par
 *    l'adaptateur, concordance exacte, attribution atomique). Le statut, le
 *    montant et les références du callback ne servent JAMAIS de preuve.
 * 6. Erreur temporaire du moteur, ou notification arrivée avant
 *    l'enregistrement de la référence → 503 temporaire (aucun changement
 *    d'état, jamais `failed`). Inconnue → accusé, aucune écriture.
 * Aucune journalisation ; réponses génériques sans donnée reçue.
 */
@Injectable()
export class CamPayWebhookService {
  private readonly verification: {
    webhookKey: string;
    now: () => number;
  } | null;

  constructor(
    @Inject(CAMPAY_WEBHOOK_CONFIG) config: CamPayWebhookConfig,
    private readonly payments: SubscriptionPaymentsService,
    configService: ConfigService,
  ) {
    if (!config.enabled) {
      this.verification = null;
      return;
    }
    assertUsableWebhookKey(config.webhookKey, [
      configService.get<string>('JWT_SECRET'),
    ]);
    this.verification = {
      webhookKey: config.webhookKey,
      now: config.now ?? Date.now,
    };
  }

  get enabled(): boolean {
    return this.verification !== null;
  }

  async handle(request: CamPayWebhookRequest): Promise<CamPayWebhookResponse> {
    const verification = this.verification;
    if (!verification) return RESPONSES.disabled;

    const parsed = parseCamPayWebhookRequest(request);
    if (!parsed.ok) {
      return parsed.error === 'too-large'
        ? RESPONSES.tooLarge
        : RESPONSES.invalid;
    }
    const notification = parsed.notification;

    const verified = verifyCamPayWebhookSignature(
      notification.signature,
      verification.webhookKey,
      verification.now(),
    );
    if (!verified.ok) return RESPONSES.unauthorized;
    if (!matchSignedNotificationFields(verified.claims, notification.fields)) {
      return RESPONSES.unauthorized;
    }

    if (notification.endpoint !== null && notification.endpoint !== 'collect') {
      return ACK;
    }

    try {
      const located = await this.payments.locateProviderNotification(
        CAMPAY_PROVIDER_NAME,
        notification.reference,
        notification.merchantReferenceHint,
      );
      if (located.kind === 'not-ready') return RESPONSES.retryLater;
      if (located.kind === 'unknown') return ACK;
      await this.payments.confirmPayment(located.paymentId);
      return ACK;
    } catch {
      // Statut CamPay indisponible, budget de confirmation épuisé, contention,
      // prestataire non branché ou base indisponible : TEMPORAIRE. Le moteur
      // conserve l'état (jamais `failed`) ; aucun journal ni détail renvoyé.
      return RESPONSES.retryLater;
    }
  }
}
