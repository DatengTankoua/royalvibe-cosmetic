import { createECDH } from 'crypto';

/**
 * 1-16A — Configuration Web Push (VAPID), lue UNE FOIS par `main.ts` avant
 * la création de l'application.
 *
 * - `WEB_PUSH_ENABLED` absent ou `false` : fonctionnalité DÉSACTIVÉE (défaut),
 *   aucune clé lue ni validée, aucun travail enregistré, aucun envoi.
 * - `WEB_PUSH_ENABLED=true` : les trois valeurs VAPID sont OBLIGATOIRES et
 *   validées strictement ; toute valeur invalide lève `WebPushConfigError`
 *   (démarrage HTTP refusé, message sans aucune valeur de clé).
 * - Toute autre valeur de `WEB_PUSH_ENABLED` est une erreur (jamais une
 *   activation implicite).
 *
 * Les clés sont fournies explicitement (jamais générées au démarrage) : un
 * abonnement navigateur reste valide après un redémarrage tant que la paire
 * ne change pas.
 */
export interface DisabledWebPushConfig {
  enabled: false;
}

export interface EnabledWebPushConfig {
  enabled: true;
  /** Clé publique P-256 non compressée, base64url (65 octets). */
  publicKey: string;
  /** Clé privée P-256, base64url (32 octets). Jamais journalisée. */
  privateKey: string;
  /** `mailto:` ou `https:` (contact du serveur d'application). */
  subject: string;
}

export type WebPushConfig = DisabledWebPushConfig | EnabledWebPushConfig;

export class WebPushConfigError extends Error {
  constructor(reason: string) {
    super(`Configuration Web Push invalide : ${reason}.`);
    this.name = 'WebPushConfigError';
  }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Décodage base64url STRICT (sans remplissage), `null` si invalide. */
export function decodeBase64Url(value: string): Buffer | null {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return null;
  const decoded = Buffer.from(value, 'base64url');
  // Rejet des encodages non canoniques (bits de fin non nuls).
  return decoded.toString('base64url') === value ? decoded : null;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WebPushConfigError(`${name} requise`);
  }
  return value.trim();
}

export function resolveWebPushConfig(
  env: NodeJS.ProcessEnv = process.env,
): WebPushConfig {
  const flag = env.WEB_PUSH_ENABLED;
  if (flag === undefined || flag === '' || flag === 'false') {
    return { enabled: false };
  }
  if (flag !== 'true') {
    throw new WebPushConfigError('WEB_PUSH_ENABLED doit valoir true ou false');
  }

  const publicKey = required(env, 'WEB_PUSH_VAPID_PUBLIC_KEY');
  const privateKey = required(env, 'WEB_PUSH_VAPID_PRIVATE_KEY');
  const subject = required(env, 'WEB_PUSH_VAPID_SUBJECT');

  const publicBytes = decodeBase64Url(publicKey);
  if (!publicBytes || publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    throw new WebPushConfigError(
      'WEB_PUSH_VAPID_PUBLIC_KEY doit être une clé P-256 non compressée en base64url',
    );
  }
  const privateBytes = decodeBase64Url(privateKey);
  if (!privateBytes || privateBytes.length !== 32) {
    throw new WebPushConfigError(
      'WEB_PUSH_VAPID_PRIVATE_KEY doit être une clé P-256 de 32 octets en base64url',
    );
  }
  // La paire doit correspondre : clé publique dérivée de la clé privée.
  let derived: Buffer;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(privateBytes);
    derived = ecdh.getPublicKey();
  } catch {
    throw new WebPushConfigError('WEB_PUSH_VAPID_PRIVATE_KEY inutilisable');
  }
  if (!derived.equals(publicBytes)) {
    throw new WebPushConfigError(
      'les clés VAPID publique et privée ne forment pas une paire',
    );
  }

  if (!isValidSubject(subject)) {
    throw new WebPushConfigError(
      'WEB_PUSH_VAPID_SUBJECT doit être une adresse mailto: ou une URL https:',
    );
  }
  return { enabled: true, publicKey, privateKey, subject };
}

function isValidSubject(subject: string): boolean {
  if (subject.length > 256) return false;
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject)) return true;
  try {
    const url = new URL(subject);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}
