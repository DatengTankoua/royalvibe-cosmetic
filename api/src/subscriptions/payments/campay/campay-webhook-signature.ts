import { createHmac, timingSafeEqual } from 'crypto';

/**
 * 1-14D.2F — Vérification du champ `signature` des notifications CamPay.
 *
 * Contrat officiel (collection Postman « CamPay API », item « Webhook or
 * Callback », consulté le 2026-10-03) : `signature` est un « jwt token. You
 * can validate this request that is coming from CamPay by using your app
 * webhook key to validate the jwt token. Use HS256 algorithm to decode. »
 * Rien d'autre n'est documenté : ni claims obligatoires, ni durée de vie, ni
 * lien avec les autres paramètres.
 *
 * Vérification (aucune bibliothèque JWT ajoutée ; `crypto` de Node) :
 * - forme compacte JWS stricte (3 segments base64url canoniques, sans
 *   remplissage), longueur bornée ;
 * - en-tête : objet JSON, `alg` EXACTEMENT `HS256` (jamais `none`, `HS384`,
 *   `RS256`…), `typ` éventuel égal à `JWT`, aucun `crit` ;
 * - HMAC-SHA256 recalculé avec la clé webhook de l'application et comparé
 *   en temps constant AVANT toute lecture du contenu ;
 * - contenu : objet JSON ;
 * - contraintes temporelles RFC 7519 appliquées SEULEMENT si présentes
 *   (`exp`, `nbf`, avec une tolérance d'horloge locale) ; aucune durée de vie
 *   maximale n'est inventée.
 * Les raisons d'échec sont internes (tests) et ne sont jamais renvoyées ni
 * journalisées.
 */

export const CAMPAY_WEBHOOK_SIGNATURE_MAX_LENGTH = 4096;
/** Tolérance d'horloge (choix local) pour `exp` / `nbf` lorsqu'ils existent. */
export const CAMPAY_WEBHOOK_CLOCK_SKEW_SECONDS = 30;

export type CamPayWebhookSignatureFailure =
  | 'malformed'
  | 'header'
  | 'algorithm'
  | 'signature'
  | 'payload'
  | 'expired'
  | 'not-yet-valid'
  | 'claims-mismatch';

export type CamPayWebhookSignatureResult =
  | { ok: true; claims: Readonly<Record<string, unknown>> }
  | { ok: false; failure: CamPayWebhookSignatureFailure };

const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Décodage base64url CANONIQUE (le réencodage doit redonner l'entrée). */
function decodeSegment(segment: string): Buffer | null {
  if (!SEGMENT.test(segment)) return null;
  const buffer = Buffer.from(segment, 'base64url');
  return buffer.toString('base64url') === segment ? buffer : null;
}

function parseObject(buffer: Buffer): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const fail = (
  failure: CamPayWebhookSignatureFailure,
): CamPayWebhookSignatureResult => ({ ok: false, failure });

export function verifyCamPayWebhookSignature(
  token: string,
  webhookKey: string,
  nowMs: number,
): CamPayWebhookSignatureResult {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > CAMPAY_WEBHOOK_SIGNATURE_MAX_LENGTH
  ) {
    return fail('malformed');
  }
  const parts = token.split('.');
  if (parts.length !== 3) return fail('malformed');
  const [headerPart, payloadPart, signaturePart] = parts;
  const headerBytes = decodeSegment(headerPart);
  const payloadBytes = decodeSegment(payloadPart);
  const signature = decodeSegment(signaturePart);
  if (!headerBytes || !payloadBytes || !signature) return fail('malformed');

  const header = parseObject(headerBytes);
  if (!header) return fail('header');
  if (header.alg !== 'HS256') return fail('algorithm');
  if (header.typ !== undefined && header.typ !== 'JWT') return fail('header');
  if (header.crit !== undefined) return fail('header');

  const expected = createHmac('sha256', webhookKey)
    .update(`${headerPart}.${payloadPart}`, 'ascii')
    .digest();
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(signature, expected)
  ) {
    return fail('signature');
  }

  const claims = parseObject(payloadBytes);
  if (!claims) return fail('payload');
  const now = Math.floor(nowMs / 1000);
  for (const name of ['exp', 'nbf', 'iat'] as const) {
    const value = claims[name];
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isFinite(value))
    ) {
      return fail('payload');
    }
  }
  if (
    typeof claims.exp === 'number' &&
    now >= claims.exp + CAMPAY_WEBHOOK_CLOCK_SKEW_SECONDS
  ) {
    return fail('expired');
  }
  if (
    typeof claims.nbf === 'number' &&
    now < claims.nbf - CAMPAY_WEBHOOK_CLOCK_SKEW_SECONDS
  ) {
    return fail('not-yet-valid');
  }
  return { ok: true, claims: Object.freeze({ ...claims }) };
}

/**
 * Paramètres de notification documentés pouvant apparaître AUSSI dans les
 * claims signés. Si un claim de ce nom existe, le paramètre reçu doit
 * exister et lui être égal (référence CamPay : insensible à la casse, UUID).
 * Les paramètres absents des claims ne sont PAS protégés par la signature.
 */
export const CAMPAY_NOTIFICATION_FIELDS = Object.freeze([
  'status',
  'reference',
  'amount',
  'currency',
  'operator',
  'code',
  'operator_reference',
  'endpoint',
  'external_reference',
  'external_user',
  'extra_first_name',
  'extra_last_name',
  'extra_email',
  'phone_number',
  'redirect_url',
  'failure_redirect_url',
  'description',
  'reason',
] as const);

export type CamPayNotificationField =
  (typeof CAMPAY_NOTIFICATION_FIELDS)[number];

const canonical = (field: string, value: unknown): string | null => {
  if (value === null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  return field === 'reference' ? value.toLowerCase() : value;
};

/**
 * Concordance claims signés ↔ paramètres reçus. Retourne la liste des
 * champs effectivement PROTÉGÉS (présents dans les claims), ou `null` en cas
 * de discordance ou de claim de type inexploitable.
 */
export function matchSignedNotificationFields(
  claims: Readonly<Record<string, unknown>>,
  params: Readonly<Partial<Record<CamPayNotificationField, unknown>>>,
): CamPayNotificationField[] | null {
  const protectedFields: CamPayNotificationField[] = [];
  for (const field of CAMPAY_NOTIFICATION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(claims, field)) continue;
    const signed = canonical(field, claims[field]);
    const received = Object.prototype.hasOwnProperty.call(params, field)
      ? canonical(field, params[field])
      : null;
    if (signed === null || received === null || signed !== received) {
      return null;
    }
    protectedFields.push(field);
  }
  return protectedFields;
}
