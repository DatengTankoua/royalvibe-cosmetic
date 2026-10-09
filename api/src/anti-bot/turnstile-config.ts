/**
 * 1-18C — Configuration de Cloudflare Turnstile (inscription publique).
 *
 * Trois états, lus depuis l'environnement et validés STRICTEMENT :
 * - `unconfigured` : aucune clé. L'inscription est REFUSÉE (503) si elle est
 *   ouverte : jamais d'inscription sans vérification anti-robot ;
 * - `cloudflare` : `TURNSTILE_SECRET_KEY` + `TURNSTILE_ALLOWED_HOSTNAMES`
 *   (+ `TURNSTILE_TIMEOUT_MS`). Les clés de TEST de Cloudflare sont refusées
 *   en production ;
 * - `simulated` : `TURNSTILE_SIMULATED=true`, vérificateur LOCAL sans réseau
 *   (tests, recette). TOUJOURS refusé avec `NODE_ENV=production`, quelles
 *   que soient les origines ; hors production, accepté seulement si
 *   `NODE_ENV=test` ou si TOUTES les origines configurées (`PUBLIC_APP_URL`,
 *   `CORS_ORIGIN`) sont en boucle locale.
 *
 * Toute valeur invalide ou ambiguë → `TurnstileConfigError` (démarrage
 * bloqué dans `main.ts`, inscription refusée à la requête). Le secret n'est
 * jamais journalisé ni renvoyé.
 */
export const TURNSTILE_SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Action du widget d'inscription (≤ 32 car., [A-Za-z0-9_-]). */
export const TURNSTILE_REGISTER_ACTION = 'register';
/**
 * Action du défi de récupération d'accès (login, `credentials/inspect`,
 * `credentials/accept`) après dépassement du plafond par compte.
 */
export const TURNSTILE_LOGIN_ACTION = 'login';
/** 1-18D — Demandes publiques de liens envoyés par e-mail (une action chacune). */
export const TURNSTILE_PASSWORD_RESET_ACTION = 'password-reset';
export const TURNSTILE_EMAIL_VERIFICATION_ACTION = 'email-verification';

/** Longueur maximale d'un jeton (documentation Cloudflare). */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;

export const TURNSTILE_DEFAULT_TIMEOUT_MS = 5000;
export const TURNSTILE_MIN_TIMEOUT_MS = 500;
export const TURNSTILE_MAX_TIMEOUT_MS = 10000;

/**
 * Clés secrètes de TEST publiées par Cloudflare (toujours valide, toujours
 * refusée, jeton déjà utilisé). Elles renvoient `hostname: localhost` et
 * `action: test` : jamais acceptées en production.
 */
export const TURNSTILE_TEST_SECRET_KEYS: ReadonlySet<string> = new Set([
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
]);
/** Action renvoyée par les clés de test (acceptée seulement avec elles). */
export const TURNSTILE_TEST_ACTION = 'test';

export type TurnstileConfig =
  | { mode: 'unconfigured' }
  | { mode: 'simulated' }
  | {
      mode: 'cloudflare';
      secret: string;
      hostnames: readonly string[];
      timeoutMs: number;
      testKeys: boolean;
    };

export class TurnstileConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnstileConfigError';
  }
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function parseHostnames(raw: string | undefined): string[] {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return [];
  const entries = trimmed.split(',').map((e) => e.trim().toLowerCase());
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!HOSTNAME.test(entry)) {
      throw new TurnstileConfigError(
        `TURNSTILE_ALLOWED_HOSTNAMES: "${entry}" n'est pas un nom d'hôte exact (sans schéma, port ni chemin).`,
      );
    }
    if (seen.has(entry)) {
      throw new TurnstileConfigError(
        `TURNSTILE_ALLOWED_HOSTNAMES: doublon "${entry}".`,
      );
    }
    seen.add(entry);
  }
  return entries;
}

function parseTimeout(raw: string | undefined): number {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return TURNSTILE_DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(trimmed)) {
    throw new TurnstileConfigError('TURNSTILE_TIMEOUT_MS doit être un entier.');
  }
  const value = Number(trimmed);
  if (value < TURNSTILE_MIN_TIMEOUT_MS || value > TURNSTILE_MAX_TIMEOUT_MS) {
    throw new TurnstileConfigError(
      `TURNSTILE_TIMEOUT_MS doit être compris entre ${TURNSTILE_MIN_TIMEOUT_MS} et ${TURNSTILE_MAX_TIMEOUT_MS}.`,
    );
  }
  return value;
}

/** Hôtes des origines publiques configurées (web, CORS). */
function configuredOriginHosts(env: NodeJS.ProcessEnv): string[] {
  const raw = [env.PUBLIC_APP_URL, ...(env.CORS_ORIGIN ?? '').split(',')]
    .map((value) => (value ?? '').trim())
    .filter((value) => value !== '');
  return raw.map((value) => {
    try {
      return new URL(value).hostname.toLowerCase();
    } catch {
      return value.toLowerCase();
    }
  });
}

/**
 * Simulation admise : jamais en production (indépendamment des origines) ;
 * sinon environnement de test, ou application entièrement en boucle locale.
 */
export function isSimulationAllowed(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_ENV === 'production') return false;
  if (env.NODE_ENV === 'test') return true;
  const hosts = configuredOriginHosts(env);
  return hosts.length > 0 && hosts.every((host) => LOOPBACK_HOSTS.has(host));
}

export function resolveTurnstileConfig(
  env: NodeJS.ProcessEnv = process.env,
): TurnstileConfig {
  const secret = (env.TURNSTILE_SECRET_KEY ?? '').trim();
  const simulatedRaw = (env.TURNSTILE_SIMULATED ?? '').trim();
  if (
    simulatedRaw !== '' &&
    simulatedRaw !== 'true' &&
    simulatedRaw !== 'false'
  ) {
    throw new TurnstileConfigError(
      'TURNSTILE_SIMULATED doit valoir true ou false.',
    );
  }
  const simulated = simulatedRaw === 'true';
  const hostnames = parseHostnames(env.TURNSTILE_ALLOWED_HOSTNAMES);
  const timeoutMs = parseTimeout(env.TURNSTILE_TIMEOUT_MS);

  if (simulated) {
    if (secret !== '') {
      throw new TurnstileConfigError(
        'TURNSTILE_SIMULATED et TURNSTILE_SECRET_KEY sont mutuellement exclusifs.',
      );
    }
    if (!isSimulationAllowed(env)) {
      throw new TurnstileConfigError(
        env.NODE_ENV === 'production'
          ? 'TURNSTILE_SIMULATED refusé en production.'
          : 'TURNSTILE_SIMULATED refusé : réservé aux tests et aux origines en boucle locale.',
      );
    }
    return { mode: 'simulated' };
  }
  if (secret === '') return { mode: 'unconfigured' };

  const testKeys = TURNSTILE_TEST_SECRET_KEYS.has(secret);
  if (testKeys && env.NODE_ENV === 'production') {
    throw new TurnstileConfigError(
      'TURNSTILE_SECRET_KEY : clé de test Cloudflare refusée en production.',
    );
  }
  if (hostnames.length === 0) {
    throw new TurnstileConfigError(
      'TURNSTILE_ALLOWED_HOSTNAMES requis avec TURNSTILE_SECRET_KEY.',
    );
  }
  if (
    env.NODE_ENV === 'production' &&
    hostnames.some((host) => LOOPBACK_HOSTS.has(host))
  ) {
    throw new TurnstileConfigError(
      'TURNSTILE_ALLOWED_HOSTNAMES : hôte local refusé en production.',
    );
  }
  return { mode: 'cloudflare', secret, hostnames, timeoutMs, testKeys };
}
