import {
  CAMPAY_NOTIFICATION_FIELDS,
  CAMPAY_WEBHOOK_SIGNATURE_MAX_LENGTH,
  CamPayNotificationField,
} from './campay-webhook-signature';

/**
 * 1-14D.2F — Lecture STRICTE des paramètres d'une notification CamPay.
 *
 * Contrat officiel : l'application CamPay choisit GET (paramètres en query)
 * ou POST (« JSON data ») ; mêmes noms de champs dans les deux cas. Ce
 * module ne fait AUCUNE confiance au contenu : il borne les tailles, refuse
 * l'ambiguïté et extrait seulement ce qui sert à déclencher une
 * vérification (`reference`, `signature`, `endpoint`, `external_reference`).
 *
 * Refusé (`invalid`) :
 * - GET avec un corps, POST avec une query (deux sources concurrentes) ;
 * - POST d'un autre type que `application/json`, corps brut absent ou qui
 *   n'est pas un objet plat de primitives ;
 * - clé dupliquée (GET : valeur tableau ; POST : détectée sur le corps BRUT,
 *   que `JSON.parse` écraserait silencieusement) ;
 * - clé hors `^[a-z_]{1,64}$` (`reference[]`, `Reference`, `a.b`…) ;
 * - trop de clés, valeur trop longue, valeur objet/tableau/booléen ;
 * - champ exploité de mauvais type (non-chaîne) ou de format invalide.
 * Trop volumineux (`too-large`) : corps brut ou URL au-delà des bornes.
 * Les clés inconnues bien formées sont ignorées (champ futur éventuel).
 */

export const CAMPAY_WEBHOOK_MAX_BODY_BYTES = 8 * 1024;
export const CAMPAY_WEBHOOK_MAX_URL_LENGTH = 8 * 1024;
export const CAMPAY_WEBHOOK_MAX_KEYS = 40;
export const CAMPAY_WEBHOOK_MAX_VALUE_LENGTH = 512;

const KEY = /^[a-z_]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Référence marchand 1-14D.2B (`merchantReferenceFor`) : `SM` + ObjectId en hexadécimal MAJUSCULE. */
const MERCHANT_REFERENCE = /^SM[0-9A-F]{24}$/;

export interface CamPayWebhookRequest {
  method: 'GET' | 'POST';
  /** Longueur de l'URL reçue (jamais l'URL elle-même). */
  urlLength: number;
  query: unknown;
  body: unknown;
  rawBody: Buffer | undefined;
  contentType: string | undefined;
}

export interface CamPayNotification {
  signature: string;
  /** Référence CamPay, en minuscules (même forme qu'à l'initiation). */
  reference: string;
  endpoint: string | null;
  /** Indice NON PROUVÉ : référence marchand annoncée, si bien formée. */
  merchantReferenceHint: string | null;
  /** Champs documentés reçus (pour la concordance avec les claims). */
  fields: Readonly<Partial<Record<CamPayNotificationField, unknown>>>;
}

export type CamPayPayloadResult =
  | { ok: true; notification: CamPayNotification }
  | { ok: false; error: 'invalid' | 'too-large' };

const invalid: CamPayPayloadResult = { ok: false, error: 'invalid' };
const tooLarge: CamPayPayloadResult = { ok: false, error: 'too-large' };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (isPlainObject(value) && Object.keys(value).length === 0);

/**
 * Clés de PREMIER niveau d'un objet JSON, lues sur le texte brut (y compris
 * les doublons). `null` si le texte n'est pas un objet JSON valide.
 */
export function topLevelJsonKeys(text: string): string[] | null {
  try {
    if (!isPlainObject(JSON.parse(text))) return null;
  } catch {
    return null;
  }
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const token = text.slice(i, j + 1);
      if (depth === 1 && expectKey) {
        keys.push(JSON.parse(token) as string);
        expectKey = false;
      }
      i = j;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
      expectKey = ch === '{' && depth === 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
    } else if (ch === ',' && depth === 1) {
      expectKey = true;
    }
  }
  return keys;
}

function collectFields(
  source: Record<string, unknown>,
  allowNumbers: boolean,
): Record<string, string | number | null> | null {
  const keys = Object.keys(source);
  if (keys.length > CAMPAY_WEBHOOK_MAX_KEYS) return null;
  const out: Record<string, string | number | null> = {};
  for (const key of keys) {
    if (!KEY.test(key)) return null;
    const value = source[key];
    const limit =
      key === 'signature'
        ? CAMPAY_WEBHOOK_SIGNATURE_MAX_LENGTH
        : CAMPAY_WEBHOOK_MAX_VALUE_LENGTH;
    if (typeof value === 'string') {
      if (value.length > limit) return null;
      out[key] = value;
    } else if (
      allowNumbers &&
      typeof value === 'number' &&
      Number.isFinite(value)
    ) {
      out[key] = value;
    } else if (allowNumbers && value === null) {
      out[key] = null;
    } else {
      // Tableau (clé dupliquée en query), objet, booléen, etc.
      return null;
    }
  }
  return out;
}

export function parseCamPayWebhookRequest(
  request: CamPayWebhookRequest,
): CamPayPayloadResult {
  if (request.urlLength > CAMPAY_WEBHOOK_MAX_URL_LENGTH) return tooLarge;
  let fields: Record<string, string | number | null> | null;
  if (request.method === 'GET') {
    if (!isEmpty(request.body) || (request.rawBody?.length ?? 0) > 0) {
      return invalid;
    }
    if (!isPlainObject(request.query)) return invalid;
    fields = collectFields(request.query, false);
  } else {
    if (!isEmpty(request.query)) return invalid;
    const mediaType = (request.contentType ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (mediaType !== 'application/json') return invalid;
    // Sans corps brut, les doublons sont indétectables : refus (échec fermé).
    if (!request.rawBody) return invalid;
    if (request.rawBody.length > CAMPAY_WEBHOOK_MAX_BODY_BYTES) return tooLarge;
    if (!isPlainObject(request.body)) return invalid;
    const keys = topLevelJsonKeys(request.rawBody.toString('utf8'));
    if (!keys || new Set(keys).size !== keys.length) return invalid;
    if (keys.length !== Object.keys(request.body).length) return invalid;
    fields = collectFields(request.body, true);
  }
  if (!fields) return invalid;

  const { signature, reference, endpoint } = fields;
  const externalReference = fields.external_reference;
  if (typeof signature !== 'string' || signature.length === 0) return invalid;
  if (typeof reference !== 'string' || !UUID.test(reference)) return invalid;
  if (endpoint !== undefined && typeof endpoint !== 'string') return invalid;
  if (
    externalReference !== undefined &&
    externalReference !== null &&
    typeof externalReference !== 'string'
  ) {
    return invalid;
  }

  const documented: Partial<Record<CamPayNotificationField, unknown>> = {};
  for (const field of CAMPAY_NOTIFICATION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, field)) {
      documented[field] = fields[field];
    }
  }
  return {
    ok: true,
    notification: {
      signature,
      reference: reference.toLowerCase(),
      endpoint: endpoint ?? null,
      merchantReferenceHint:
        typeof externalReference === 'string' &&
        MERCHANT_REFERENCE.test(externalReference)
          ? externalReference
          : null,
      fields: Object.freeze(documented),
    },
  };
}
