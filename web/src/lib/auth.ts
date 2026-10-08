// 1-16H — Clés `localStorage` de la session (seule définition). Renommées
// depuis `heyama_*` avant la mise en production, sans reprise des anciennes
// clés : une session de développement existante doit se reconnecter.
export const TOKEN_KEY = "stockmaster_token";
export const USER_KEY = "stockmaster_user";

export interface StoredUser {
  _id: string;
  name: string;
  email: string;
  role: "admin" | "seller";
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getStoredUser(): StoredUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as StoredUser) : null;
  } catch {
    return null;
  }
}

export function setStoredUser(user: StoredUser): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/**
 * 1-15A : clé de session applicative (jeton ou utilisateur) modifiée dans un
 * AUTRE onglet — `null` = `localStorage.clear()`.
 */
export function isAuthStorageKey(key: string | null): boolean {
  return key === null || key === TOKEN_KEY || key === USER_KEY;
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}
