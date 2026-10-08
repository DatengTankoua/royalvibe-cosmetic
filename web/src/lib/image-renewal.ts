// R2 privé — renouvellement BORNÉ des liens d'image signés (durée limitée).
//
// Une image dont le chargement échoue (lien expiré, fichier absent,
// stockage indisponible) demande UNE relecture authentifiée des écrans
// montés (leur `request()` de `useLiveRefresh` : regroupée, sérialisée,
// jamais hors ligne), qui renvoient des liens neufs. Bornes :
// - une même image (lien sans sa signature) ne redemande pas avant
//   `IMAGE_RENEWAL_IDENTITY_MS` : un fichier absent ne relance donc pas de
//   relecture à chaque échec ;
// - toutes images confondues, au plus une demande par
//   `IMAGE_RENEWAL_MIN_INTERVAL_MS` ;
// - jamais de rechargement de page, aucun cache persistant des images.
export const IMAGE_RENEWAL_IDENTITY_MS = 5 * 60_000;
export const IMAGE_RENEWAL_MIN_INTERVAL_MS = 10_000;

const handlers = new Set<() => void>();
const lastByIdentity = new Map<string, number>();
let lastRequestAt = Number.NEGATIVE_INFINITY;

/** Lien sans paramètres de requête (la signature change à chaque relecture). */
export function imageIdentity(src: string): string {
  try {
    const url = new URL(src);
    return `${url.origin}${url.pathname}`;
  } catch {
    return src;
  }
}

/** Abonne une relecture d'écran ; renvoie le désabonnement. */
export function registerImageRenewal(handler: () => void): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/**
 * Demande bornée de liens neufs après l'échec de `src`. Renvoie `true` si
 * une relecture a été demandée, `false` si une borne l'en empêche.
 */
export function requestImageRenewal(src: string, now = Date.now()): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return false;
  }
  if (handlers.size === 0) return false;
  const identity = imageIdentity(src);
  const last = lastByIdentity.get(identity);
  if (last !== undefined && now - last < IMAGE_RENEWAL_IDENTITY_MS) {
    return false;
  }
  if (now - lastRequestAt < IMAGE_RENEWAL_MIN_INTERVAL_MS) return false;
  lastByIdentity.set(identity, now);
  lastRequestAt = now;
  for (const handler of [...handlers]) handler();
  return true;
}

/** Tests uniquement : état des bornes remis à zéro. */
export function resetImageRenewalForTests(): void {
  handlers.clear();
  lastByIdentity.clear();
  lastRequestAt = Number.NEGATIVE_INFINITY;
}
