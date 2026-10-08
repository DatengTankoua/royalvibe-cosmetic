import { isJwtExpired } from "./jwt";

// 1-14C.2 — Session LIMITÉE (abonnement du commerce inactif).
//
// Le jeton limité (`restrictedToken`, 15 min) renvoyé par le login ou le
// switch est conservé SÉPARÉMENT du JWT applicatif :
// - `sessionStorage` (onglet courant), clé dédiée — jamais la clé du token
//   applicatif, jamais IndexedDB ni Cache Storage ;
// - utilisé uniquement par des appels explicites (en-tête fourni) : jamais
//   ajouté par l'intercepteur Axios ;
// - supprimé à l'expiration, à la déconnexion et après l'échange de reprise.
// Le décodage local de `exp` ne sert qu'au ménage ; l'autorité reste le
// serveur.

const RESTRICTED_SESSION_KEY = "stockmaster_restricted_session";

export function getRestrictedToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const token = window.sessionStorage.getItem(RESTRICTED_SESSION_KEY);
    // Expiré : ignoré mais conservé jusqu'à `clearRestrictedToken()`, pour
    // afficher un message de reconnexion compréhensible.
    if (!token || isJwtExpired(token)) return null;
    return token;
  } catch {
    return null;
  }
}

/** `true` si un jeton limité est stocké, même expiré (message de retour). */
export function hasStoredRestrictedToken(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(RESTRICTED_SESSION_KEY) !== null;
  } catch {
    return false;
  }
}

export function setRestrictedToken(token: string): void {
  try {
    window.sessionStorage.setItem(RESTRICTED_SESSION_KEY, token);
  } catch {
    // Stockage indisponible : la session limitée ne survivra pas au
    // rechargement (retour à la connexion), sans autre effet.
  }
}

export function clearRestrictedToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(RESTRICTED_SESSION_KEY);
  } catch {
    // best effort
  }
}
