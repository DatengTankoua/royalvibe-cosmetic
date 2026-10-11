import { createHmac, timingSafeEqual } from 'crypto';

/**
 * 1-21B — Authenticité d'une notification SasPay (contrat officiel,
 * page « Webhooks ») :
 * - `X-Webhook-Signature` : HMAC-SHA256, hexadécimal en minuscules, de
 *   `"{X-Webhook-Timestamp}.{corps BRUT}"` avec le secret de signature ;
 * - `X-Webhook-Timestamp` : secondes Unix, rejeté au-delà de 300 s d'écart ;
 * - calcul sur les OCTETS reçus (jamais une re-sérialisation), comparaison
 *   en temps constant.
 */
export const SASPAY_WEBHOOK_TOLERANCE_SECONDS = 300;

const SIGNATURE = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^[0-9]{1,12}$/;

export type SasPaySignatureCheck = 'valid' | 'invalid' | 'stale';

export function verifySasPayWebhookSignature(input: {
  rawBody: Buffer;
  signature: unknown;
  timestamp: unknown;
  secret: string;
  nowMs: number;
}): SasPaySignatureCheck {
  const { signature, timestamp } = input;
  if (
    typeof signature !== 'string' ||
    typeof timestamp !== 'string' ||
    !SIGNATURE.test(signature) ||
    !TIMESTAMP.test(timestamp)
  ) {
    return 'invalid';
  }
  const expected = createHmac('sha256', input.secret)
    .update(`${timestamp}.`)
    .update(input.rawBody)
    .digest();
  const received = Buffer.from(signature, 'hex');
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  ) {
    return 'invalid';
  }
  const age = Math.abs(Math.floor(input.nowMs / 1000) - Number(timestamp));
  return age > SASPAY_WEBHOOK_TOLERANCE_SECONDS ? 'stale' : 'valid';
}
