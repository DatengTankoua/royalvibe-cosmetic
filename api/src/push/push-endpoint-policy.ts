import { decodeBase64Url } from './push-config';

/**
 * 1-16A — Politique des abonnements push reçus des navigateurs.
 *
 * Le serveur envoie une requête HTTPS sortante vers l'`endpoint` fourni par
 * le navigateur : il est donc traité comme une DESTINATION NON FIABLE.
 * Seuls les services push documentés des navigateurs pris en charge sont
 * acceptés, en HTTPS, port par défaut, sans identifiants ni adresse IP :
 *
 * | Hôte                                  | Navigateurs                         |
 * | ------------------------------------- | ----------------------------------- |
 * | `fcm.googleapis.com`                  | Chrome, Chromium, Android           |
 * | `updates.push.services.mozilla.com`   | Firefox                             |
 * | `web.push.apple.com`, `*.push.apple.com` | Safari macOS, iOS/iPadOS ≥ 16.4 (PWA) |
 * | `*.notify.windows.com`                | Edge (WNS)                          |
 *
 * Toute autre destination (hôte arbitraire, adresse privée, IP littérale,
 * `http:`, port explicite) est refusée à l'enregistrement ET revérifiée
 * avant chaque envoi.
 */
export const PUSH_SERVICE_EXACT_HOSTS: readonly string[] = Object.freeze([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);

export const PUSH_SERVICE_HOST_SUFFIXES: readonly string[] = Object.freeze([
  '.push.apple.com',
  '.notify.windows.com',
]);

export const PUSH_ENDPOINT_MAX_LENGTH = 2048;
/** Base64url de 65 octets : 87 caractères. */
const P256DH_MAX_LENGTH = 100;
/** Base64url de 16 octets : 22 caractères. */
const AUTH_MAX_LENGTH = 32;

export interface ValidatedPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function allowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (PUSH_SERVICE_EXACT_HOSTS.includes(host)) return true;
  return PUSH_SERVICE_HOST_SUFFIXES.some(
    (suffix) =>
      host.endsWith(suffix) &&
      host.length > suffix.length &&
      // Libellé DNS simple devant le suffixe (jamais un point vide).
      /^[a-z0-9-]+$/.test(host.slice(0, host.length - suffix.length)),
  );
}

/** Vrai si l'endpoint est une destination push autorisée. */
export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string') return false;
  if (endpoint.length === 0 || endpoint.length > PUSH_ENDPOINT_MAX_LENGTH) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    url.hash === '' &&
    allowedHost(url.hostname)
  );
}

/**
 * Clés de chiffrement du navigateur (RFC 8291) : `p256dh` = point P-256 non
 * compressé (65 octets), `auth` = secret de 16 octets, base64url strict.
 */
export function validatePushSubscriptionInput(input: {
  endpoint: unknown;
  keys: { p256dh: unknown; auth: unknown } | null | undefined;
}): ValidatedPushSubscription | null {
  if (!isAllowedPushEndpoint(input.endpoint)) return null;
  const p256dh = input.keys?.p256dh;
  const auth = input.keys?.auth;
  if (typeof p256dh !== 'string' || p256dh.length > P256DH_MAX_LENGTH) {
    return null;
  }
  if (typeof auth !== 'string' || auth.length > AUTH_MAX_LENGTH) return null;
  const key = decodeBase64Url(p256dh);
  const secret = decodeBase64Url(auth);
  if (!key || key.length !== 65 || key[0] !== 0x04) return null;
  if (!secret || secret.length !== 16) return null;
  return { endpoint: input.endpoint, p256dh, auth };
}
