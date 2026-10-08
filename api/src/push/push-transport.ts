import * as webpush from 'web-push';
import type { EnabledWebPushConfig } from './push-config';
import { isAllowedPushEndpoint } from './push-endpoint-policy';

/**
 * 1-16A — Transport Web Push. L'implémentation réelle (`WebPushTransport`,
 * bibliothèque `web-push` : chiffrement RFC 8291 `aes128gcm`, jeton VAPID
 * RFC 8292) n'est instanciée QUE par l'activation HTTP (`main.ts`) ; les
 * tests injectent un faux transport (aucun réseau).
 */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSendOptions {
  /** Durée de conservation par le service push, en secondes. */
  ttlSeconds: number;
  /** En-tête `Topic` : un message non livré de même sujet est remplacé. */
  topic: string;
}

/**
 * Résultat d'UN envoi. `statusCode` absent : panne réseau ou délai dépassé
 * (reprise bornée). Jamais de corps de réponse ni d'en-tête conservé.
 */
export interface PushSendResult {
  statusCode: number | null;
  /** Code générique (`network`, `timeout`, `refused-endpoint`). */
  error?: string;
}

export interface PushTransport {
  send(
    target: PushTarget,
    payload: string,
    options: PushSendOptions,
  ): Promise<PushSendResult>;
}

/** Délai réseau d'un envoi (connexion + réponse). */
export const PUSH_SEND_TIMEOUT_MS = 10_000;
/** Délai global d'un envoi. */
export const PUSH_SEND_DEADLINE_MS = 15_000;

export class WebPushTransport implements PushTransport {
  constructor(private readonly config: EnabledWebPushConfig) {}

  async send(
    target: PushTarget,
    payload: string,
    options: PushSendOptions,
  ): Promise<PushSendResult> {
    // Défense en profondeur : destination revérifiée avant toute requête.
    if (!isAllowedPushEndpoint(target.endpoint)) {
      return { statusCode: null, error: 'refused-endpoint' };
    }
    let deadline: NodeJS.Timeout | undefined;
    try {
      // `timeout` de `web-push` borne l'inactivité du socket ; ce délai
      // global borne aussi une réponse lente mais continue.
      const expired = new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () =>
            reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
          PUSH_SEND_DEADLINE_MS,
        );
      });
      const sending = webpush.sendNotification(
        {
          endpoint: target.endpoint,
          keys: { p256dh: target.p256dh, auth: target.auth },
        },
        payload,
        {
          vapidDetails: {
            subject: this.config.subject,
            publicKey: this.config.publicKey,
            privateKey: this.config.privateKey,
          },
          TTL: options.ttlSeconds,
          topic: options.topic,
          urgency: 'normal',
          contentEncoding: 'aes128gcm',
          timeout: PUSH_SEND_TIMEOUT_MS,
        },
      );
      const response = await Promise.race([sending, expired]);
      return { statusCode: response.statusCode };
    } catch (error) {
      // `WebPushError` porte le statut HTTP ; jamais son corps, ses en-têtes
      // ni l'endpoint (non journalisés).
      const statusCode = (error as { statusCode?: unknown }).statusCode;
      if (typeof statusCode === 'number') return { statusCode };
      const code = (error as { code?: unknown }).code;
      return {
        statusCode: null,
        error:
          code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT'
            ? 'timeout'
            : 'network',
      };
    } finally {
      clearTimeout(deadline);
    }
  }
}
