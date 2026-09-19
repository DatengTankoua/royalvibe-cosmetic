/**
 * Parser d'origines autorisées Socket.IO — phase 0B.3.
 *
 * Source de vérité : la variable d'environnement `CORS_ORIGIN`, déjà utilisée
 * pour le CORS HTTP (non modifié en 0B.3, réutilisée telle quelle). Format :
 * une ou plusieurs origines exactes séparées par des virgules.
 *
 * Règles de sécurité — une origine autorisée est une ORIGINE EXACTE :
 * - seuls les protocoles http: et https: ;
 * - pas de chemin (`/a`), pas de query (`?x=1`), pas de fragment (`#a`),
 *   pas d'userinfo, pas de slash de fin ;
 * - wildcard `*` et motifs partiels refusés ;
 * - comparaison aval (gateway / allowRequest) : ÉGALITÉ EXACTE sur la
 *   liste produite — jamais de sous-domaine, jamais de `endsWith`, jamais
 *   `*.vercel.app` ;
 * - production : valeur absente ou vide → erreur FATALE au démarrage
 *   (aucune valeur par défaut ouverte) ;
 * - développement / test : absente ou vide → fallback LOCAL_DEV_ORIGINS
 *   (les origines locales réellement nécessaires ; aucun wildcard).
 *
 * Réutilisable tel quel par la future phase 0B.4 (CORS HTTP global en
 * strict).
 */

export type OriginEnvironment = 'production' | 'development' | 'test';

/**
 * Origines locales réellement nécessaires au développement et aux tests
 * (frontend dev sur 3000 ; backend écoutant n'EST PAS un client → non
 * incluse ici). Aucun wildcard. Documenté dans le rapport 0B.3.
 */
export const LOCAL_DEV_ORIGINS: readonly string[] = Object.freeze([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

/** Erreur de configuration invalide (message sans secret). */
export class OriginConfigError extends Error {}

/**
 * Méthodes autorisées du CORS HTTP (phase 0B.4) — minimum exigé :
 * GET, POST, PUT, PATCH, DELETE + OPTIONS (préflight).
 */
export const HTTP_CORS_METHODS: readonly string[] = Object.freeze([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

/**
 * En-têtes autorisés du CORS HTTP (phase 0B.4) — minimum exigé :
 * `Content-Type` + `Authorization` (auth Bearer ; les en-têtes non
 * simples sont signalés via le préflight).
 */
export const HTTP_CORS_ALLOWED_HEADERS: readonly string[] = Object.freeze([
  'Content-Type',
  'Authorization',
]);

/**
 * Résultat d'un contrôle d'origine : `allowed === true` ⇒ l'origine est
 * STRICTEMENT dans l'allowlist.
 */
export interface OriginAllowlist {
  readonly origins: readonly string[];
  /** Égalité exacte sur l'allowlist ; refuse absence de chaîne ET inconnue. */
  isAllowed(origin: string | undefined | null): boolean;
  /**
   * Delegate de contrôle d'origine. `origin` : valeur de l'en-tête
   * `Origin` (null/undefined si absent). Callback reçoivent `allowed` (la
   * liste autorisée si l'origine est exacte, sinon `null`/`undefined`).
   */
  corsDelegate(
    origin: string | null | undefined,
    cb: (err: null, allowed: readonly string[] | null | undefined) => void,
  ): void;
}

function normalizeOneOrigin(entry: string): string {
  if (entry.includes('*')) {
    // Wildcard : jamais autorisé, où qu'il apparaisse (`*`,
    // `https://*.vercel.app`, …) — une origine autorisée est exacte.
    throw new OriginConfigError(
      `CORS_ORIGIN: wildcard "*" is not allowed in "${entry}" (exact origins only).`,
    );
  }
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw new OriginConfigError(`CORS_ORIGIN: invalid URL "${entry}".`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OriginConfigError(
      `CORS_ORIGIN: protocol "${url.protocol}" must be http: or https: ("${entry}").`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new OriginConfigError(
      `CORS_ORIGIN: userinfo is not allowed in an origin ("${entry}").`,
    );
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new OriginConfigError(
      `CORS_ORIGIN: path, query or fragment are not allowed ("${entry}").`,
    );
  }
  if (url.hostname === '') {
    throw new OriginConfigError(`CORS_ORIGIN: missing host in "${entry}".`);
  }
  // Normalisation raisonnable : une origine ne porte pas le slash final de
  // l'URL, ni de chemin (refusé ci-dessus).
  const port = url.port !== '' ? `:${url.port}` : '';
  return `${url.protocol}//${url.hostname}${port}`;
}

/**
 * Parser pur de la variable CORS_ORIGIN.
 *
 * - valeurs séparées par virgules ; espaces et sauts de ligne supprimés
 *   autour de chaque valeur ;
 * - valeur vide (double virgule, entrée manquante dans une liste partielle)
 *   → ignorée (pas de faille) ;
 * - doublons retirés (ordre de premier-occurrence conservé) ;
 * - `undefined` / `null` en production → erreur fatale ; en dev/test →
 *   fallback LOCAL_DEV_ORIGINS ;
 * - liste vide effective (toutes les valeurs invalides) en production →
 *   erreur fatale ; en dev/test → fallback LOCAL_DEV_ORIGINS.
 */
export function parseCORSOrigin(
  raw: string | undefined | null,
  environment: OriginEnvironment = 'development',
): string[] {
  if (raw === undefined || raw === null) {
    if (environment === 'production') {
      throw new OriginConfigError(
        'CORS_ORIGIN is required in production (no open default).',
      );
    }
    return [...LOCAL_DEV_ORIGINS];
  }
  const entries = raw.split(',').map((value) => value.trim());
  const seen = new Set<string>();
  const origins: string[] = [];
  for (const entry of entries) {
    if (entry === '') continue;
    const normalized = normalizeOneOrigin(entry);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      origins.push(normalized);
    }
  }
  if (origins.length === 0) {
    if (environment === 'production') {
      throw new OriginConfigError(
        'CORS_ORIGIN resolved to an empty allowlist in production.',
      );
    }
    return [...LOCAL_DEV_ORIGINS];
  }
  return origins;
}

/**
 * Fabrique l'allowlist complète à partir d'une liste d'origines exactes.
 * `isAllowed` : ÉGALITÉ EXACTE uniquement.
 * `corsDelegate` : renvoie la liste à `cors` en cas d'origine validée ;
 * renvoie `undefined` sinon (le package `cors` ne réfléchit alors pas
 * d'en-tête d'autorisation).
 */
export function buildOriginAllowlist(
  origins: readonly string[],
): OriginAllowlist {
  const set = new Set(origins);
  return {
    origins,
    isAllowed(origin) {
      if (typeof origin !== 'string' || origin.length === 0) {
        return false;
      }
      return set.has(origin);
    },
    corsDelegate(origin, cb) {
      if (typeof origin === 'string' && set.has(origin)) {
        cb(null, origins);
      } else {
        cb(null, undefined);
      }
    },
  };
}

/**
 * Factory des options CORS HTTP striktes (phase 0B.4) — factory UNIQUE
 * partagée par `main.ts` et les E2E : les deux ne peuvent donc plus
 * diverger. `requestOrigin` = valeur de l'en-tête `Origin`
 * (null/undefined si absent) :
 * - origine autorisée → `cb(null, true)` : le package `cors` réfléchit
 *   l'ORIGINE EXACTE en `Access-Control-Allow-Origin` (égalité stricte) ;
 * - origine absente / inconnue → `cb(null, false)` : la requête CONTINUE
 *   SANS en-tête CORS et SANS 500 (`undefined` serait falsy et déclencherait
 *   une 500 dans cors@2.8.6 — `if (err2 || !origin) next(err2)`).
 * Jamais `credentials` (auth Bearer, pas cookie) ; méthodes/headers
 * explicites (jamais réfléchis).
 */
export function buildHttpCorsOptions(allowlist: OriginAllowlist): {
  origin: (
    requestOrigin: string | undefined,
    callback: (err: Error | null, origin?: boolean) => void,
  ) => void;
  methods: readonly string[];
  allowedHeaders: readonly string[];
} {
  return {
    origin: (requestOrigin, callback) =>
      callback(null, allowlist.isAllowed(requestOrigin ?? null)),
    methods: HTTP_CORS_METHODS,
    allowedHeaders: HTTP_CORS_ALLOWED_HEADERS,
  };
}
