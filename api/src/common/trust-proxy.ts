import { isIP } from 'net';
import { resolveTrustProxyHops } from './auth-rate-limiting';

/**
 * 1-14D.2E — Confiance accordée aux reverse proxys (Express `trust proxy`).
 *
 * Express ne calcule `req.ip` depuis `X-Forwarded-For` que pour les sauts
 * APPROUVÉS ; sinon `req.ip` est l'adresse de la socket. Toute la
 * limitation de débit par IP (`ThrottlerGuard.getTracker` → `req.ip`)
 * dépend de ce réglage.
 *
 * Trois modes, mutuellement exclusifs, parsés STRICTEMENT au démarrage :
 * - aucun (défaut) : `TRUST_PROXY_HOPS` absent/`0` et
 *   `TRUST_PROXY_ADDRESSES` absent/vide → aucun proxy approuvé ;
 * - adresses (recommandé derrière le nginx du dépôt) :
 *   `TRUST_PROXY_ADDRESSES` = liste d'adresses IP EXACTES des proxys
 *   identifiés (ex. l'adresse fixe de nginx sur le réseau `edge`). Seule
 *   une connexion venant de ces adresses peut fournir `X-Forwarded-For` ;
 *   un accès direct depuis une autre source ne peut pas usurper d'adresse ;
 * - sauts : `TRUST_PROXY_HOPS` = N (contrat 0B.6 conservé) — acceptable
 *   UNIQUEMENT si TOUS les chemins vers l'API traversent exactement N
 *   proxys de confiance (à vérifier sur le déploiement réel).
 *
 * Jamais `true` (confiance globale), jamais de plage (CIDR) ni de mot-clé
 * (`loopback`, `uniquelocal`…) : aucun réseau privé n'est approuvé en bloc.
 */

export type TrustProxySetting =
  | { mode: 'none' }
  | { mode: 'hops'; hops: number }
  | { mode: 'addresses'; addresses: readonly string[] };

/** Nombre maximal d'adresses de proxy approuvées. */
export const TRUST_PROXY_MAX_ADDRESSES = 8;

const UNSPECIFIED = new Set(['0.0.0.0', '::']);

export class TrustProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustProxyConfigError';
  }
}

/**
 * `TRUST_PROXY_ADDRESSES` : adresses IPv4/IPv6 exactes séparées par des
 * virgules (espaces autour tolérés). Toute entrée vide, invalide, plage,
 * mot-clé, adresse non spécifiée ou doublon → erreur (aucune interprétation
 * partielle). Absente ou vide → `[]`.
 */
export function parseTrustProxyAddresses(raw: string | undefined): string[] {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return [];
  const entries = trimmed.split(',').map((entry) => entry.trim());
  if (entries.length > TRUST_PROXY_MAX_ADDRESSES) {
    throw new TrustProxyConfigError(
      `TRUST_PROXY_ADDRESSES: at most ${TRUST_PROXY_MAX_ADDRESSES} addresses.`,
    );
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (isIP(entry) === 0) {
      throw new TrustProxyConfigError(
        `TRUST_PROXY_ADDRESSES: "${entry}" is not an exact IP address.`,
      );
    }
    const key = entry.toLowerCase();
    if (UNSPECIFIED.has(key)) {
      throw new TrustProxyConfigError(
        'TRUST_PROXY_ADDRESSES: unspecified address is not allowed.',
      );
    }
    if (seen.has(key)) {
      throw new TrustProxyConfigError(
        `TRUST_PROXY_ADDRESSES: duplicate address "${entry}".`,
      );
    }
    seen.add(key);
  }
  return entries;
}

/** Réglage complet depuis l'environnement ; erreur fatale si ambigu. */
export function resolveTrustProxySetting(
  env: NodeJS.ProcessEnv = process.env,
): TrustProxySetting {
  const hops = resolveTrustProxyHops(env.TRUST_PROXY_HOPS);
  const addresses = parseTrustProxyAddresses(env.TRUST_PROXY_ADDRESSES);
  if (hops > 0 && addresses.length > 0) {
    throw new TrustProxyConfigError(
      'TRUST_PROXY_HOPS and TRUST_PROXY_ADDRESSES are mutually exclusive.',
    );
  }
  if (addresses.length > 0) return { mode: 'addresses', addresses };
  if (hops > 0) return { mode: 'hops', hops };
  return { mode: 'none' };
}

/** Valeur transmise à Express ; `undefined` : ne rien régler (défaut). */
export function expressTrustProxyValue(
  setting: TrustProxySetting,
): number | string[] | undefined {
  switch (setting.mode) {
    case 'none':
      return undefined;
    case 'hops':
      return setting.hops;
    case 'addresses':
      return [...setting.addresses];
  }
}

/** Sous-ensemble de l'application Express utilisé ici. */
export interface ExpressSettings {
  set(name: string, value: unknown): unknown;
}

/**
 * Applique le réglage à l'instance Express (bootstrap `main.ts`, et les
 * tests qui doivent reproduire exactement le même comportement).
 */
export function applyTrustProxy(
  expressInstance: ExpressSettings,
  setting: TrustProxySetting,
): void {
  const value = expressTrustProxyValue(setting);
  if (value !== undefined) expressInstance.set('trust proxy', value);
}
