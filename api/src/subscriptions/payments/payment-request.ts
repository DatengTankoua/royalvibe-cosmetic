import { createHmac } from 'crypto';
import type { Types } from 'mongoose';
import type { SubscriptionTerm } from '../subscription-terms';

/**
 * 1-14D.2B — Règles PURES d'une demande de paiement (aucune I/O).
 *
 * Téléphone du payeur : utilisé TRANSITOIREMENT pour l'initiation ; seuls
 * sa forme masquée et une empreinte (HMAC, jamais un hash nu, l'espace des
 * numéros étant trop petit) sont conservés.
 */

/** Indicatif Cameroun ; numéros mobiles nationaux : 9 chiffres, `6…`. */
const CAMEROON_PREFIX = '237';
const NATIONAL_MOBILE = /^6\d{8}$/;
/** Séparateurs tolérés à la saisie : espaces, points, tirets, parenthèses. */
const SEPARATORS = /[\s.\-()]/g;
export const PAYER_PHONE_INPUT_MAX_LENGTH = 32;

/**
 * Forme canonique `237XXXXXXXXX` d'un numéro mobile camerounais, ou `null`.
 * Accepte `6XXXXXXXX`, `2376XXXXXXXX`, `+2376XXXXXXXX`, `002376XXXXXXXX`,
 * avec séparateurs. Tout autre format est refusé.
 */
export function normalizePayerPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > PAYER_PHONE_INPUT_MAX_LENGTH) return null;
  let digits = value.trim().replace(SEPARATORS, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 12 && digits.startsWith(CAMEROON_PREFIX)) {
    digits = digits.slice(CAMEROON_PREFIX.length);
  }
  return NATIONAL_MOBILE.test(digits) ? `${CAMEROON_PREFIX}${digits}` : null;
}

/** `+237 6•• ••• •12` : premier chiffre national et deux derniers seulement. */
export function maskPayerPhone(normalized: string): string {
  const national = normalized.slice(CAMEROON_PREFIX.length);
  return `+${CAMEROON_PREFIX} ${national[0]}•• ••• •${national.slice(-2)}`;
}

const FINGERPRINT_CONTEXT = 'stockmaster:subscription-payment-request:v1';

/**
 * Clé HMAC dédiée, dérivée du secret serveur (séparation de domaine) : un
 * attaquant lisant la base ne peut pas retrouver le numéro par force brute.
 */
export function derivePaymentFingerprintKey(serverSecret: string): Buffer {
  if (typeof serverSecret !== 'string' || serverSecret.length === 0) {
    throw new Error('Secret serveur requis pour les empreintes de paiement.');
  }
  return createHmac('sha256', serverSecret)
    .update(FINGERPRINT_CONTEXT)
    .digest();
}

export interface NormalizedPaymentRequest {
  requestedBy: string;
  term: SubscriptionTerm;
  payerPhone: string;
}

/**
 * Empreinte de la demande normalisée (demandeur, durée, téléphone), tableau
 * à ORDRE FIXE. L'organisation et le `clientOperationId` portent l'index
 * unique ; le MONTANT n'y entre jamais (un rejeu après changement de tarif
 * reste le même paiement, au tarif figé).
 */
export function computePaymentRequestFingerprint(
  key: Buffer,
  request: NormalizedPaymentRequest,
): string {
  return createHmac('sha256', key)
    .update(
      JSON.stringify([
        'v1',
        request.requestedBy,
        request.term,
        request.payerPhone,
      ]),
    )
    .digest('hex');
}

/**
 * Référence marchand IMMUABLE, dérivée de l'identifiant du paiement
 * (26 caractères alphanumériques, compatible avec les limites usuelles des
 * prestataires, ex. 30 caractères).
 */
export function merchantReferenceFor(paymentId: Types.ObjectId): string {
  return `SM${paymentId.toHexString().toUpperCase()}`;
}

/** Référence d'attribution dans le registre des périodes. */
export function paymentGrantReference(paymentId: Types.ObjectId): string {
  return `payment:${paymentId.toHexString()}`;
}
