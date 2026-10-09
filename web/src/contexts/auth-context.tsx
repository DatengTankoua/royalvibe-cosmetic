"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import axios from "axios";
import { useLocale } from "@/i18n/locale-provider";
import {
  getToken,
  setToken,
  getStoredUser,
  setStoredUser,
  clearAuth,
  isAuthStorageKey,
  type StoredUser,
} from "@/lib/auth";
import {
  authLogin,
  completeSubscriptionAccess,
  fetchMe,
  updateAccountLocale,
  getApiErrorCode,
  getApiErrorMessage,
  readSubscriptionInactive,
  SUBSCRIPTION_INACTIVE,
  type SelectableOrganization,
} from "@/lib/api";
import {
  clearRestrictedToken,
  getRestrictedToken,
  setRestrictedToken,
} from "@/lib/restricted-session";
import { purgeAllOfflineData } from "@/lib/offline-purge";
import { releasePushOnLogout } from "@/lib/push-notifications";
import { clearTenantBrand } from "@/lib/offline-tenant-brand-db";

export type LoginOutcome =
  | { status: "success" }
  | {
      status: "organizationSelectionRequired";
      organizations: SelectableOrganization[];
    }
  // 1-14C.2 : identifiants valides, abonnement du commerce inactif — session
  // LIMITÉE ouverte (jeton séparé), jamais de JWT applicatif.
  | { status: "subscriptionInactive" };

/**
 * Résultat de l'échange de reprise d'une session limitée :
 * - `installed` : JWT applicatif installé (session toujours courante) ;
 * - `inactive` : abonnement toujours inactif ;
 * - `expired` : jeton limité expiré ou refusé (reconnexion requise) ;
 * - `stale` : la session a changé pendant l'échange — rien n'est installé ;
 * - `unavailable` : vérification momentanément impossible.
 */
export type RestrictedAccessOutcome =
  "installed" | "inactive" | "expired" | "stale" | "unavailable";

interface AuthContextValue {
  user: StoredUser | null;
  isLoading: boolean;
  // Incrémenté à chaque changement de JWT (login réussi) — permet à
  // useSocket() de forcer une reconnexion. 1-12A : plus de switch
  // d'organisation dans l'UI (logout puis login multi-organisation) ;
  // `switchOrganization` reste disponible dans lib/api.ts (contrat bas
  // niveau, endpoint backend inchangé).
  sessionVersion: number;
  login: (
    email: string,
    password: string,
    organizationId?: string,
    challengeToken?: string,
  ) => Promise<LoginOutcome>;
  logout: () => Promise<void>;
  // 1-14C.2 : jeton LIMITÉ courant (sessionStorage), jamais le JWT applicatif.
  restrictedToken: string | null;
  completeRestrictedAccess: () => Promise<RestrictedAccessOutcome>;
  /** Ferme la session limitée (expiration, déconnexion). */
  endRestrictedSession: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Échec de connexion : message affichable + code stable éventuel de l'API. */
export class LoginError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "LoginError";
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<StoredUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionVersion, setSessionVersion] = useState(0);
  const [restrictedToken, setRestrictedState] = useState<string | null>(null);
  // 1-14C.2 : époque de session — incrémentée à chaque login, logout,
  // installation ou fin de session limitée. Une réponse tardive (échange de
  // reprise) d'une époque révolue n'installe JAMAIS rien.
  const epochRef = useRef(0);
  // 1-15A : session (jeton + utilisateur) reflétée par l'état de CET onglet.
  const installedRef = useRef<{ token: string | null; user: string | null }>({
    token: null,
    user: null,
  });
  const markInstalled = useCallback(() => {
    installedRef.current = {
      token: getToken(),
      user: JSON.stringify(getStoredUser()),
    };
  }, []);

  useEffect(() => {
    const stored = getStoredUser();
    const token = getToken();
    if (stored && token) setUser(stored);
    markInstalled();
    setRestrictedState(getRestrictedToken());
    setIsLoading(false);
  }, [markInstalled]);

  // 1-15A — la session applicative est partagée par les onglets (même
  // `localStorage`). Une connexion ou une déconnexion dans un AUTRE onglet
  // remplace le jeton utilisé par cet onglet pour ses requêtes : l'onglet
  // adopte immédiatement la nouvelle session (nouvelle `sessionVersion` :
  // contexte relu, socket rouvert, pages remontées) ou la quitte, au lieu
  // d'afficher l'ancienne organisation avec des réponses de la nouvelle.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (!isAuthStorageKey(event.key)) return;
      const token = getToken();
      const stored = getStoredUser();
      const installed = installedRef.current;
      const userJson = JSON.stringify(stored);
      if (token === installed.token && userJson === installed.user) return;
      const tokenChanged = token !== installed.token;
      installedRef.current = { token, user: userJson };
      epochRef.current += 1;
      if (!token || !stored) {
        setUser(null);
        return;
      }
      setUser(stored);
      if (tokenChanged) setSessionVersion((v) => v + 1);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const endRestrictedSession = useCallback(() => {
    epochRef.current += 1;
    clearRestrictedToken();
    setRestrictedState(null);
  }, []);

  // N'accepte JAMAIS de conserver le mot de passe : il ne fait que transiter
  // vers l'appel API, aucun state du contexte ne le stocke.
  const login = useCallback(
    async (
      email: string,
      password: string,
      organizationId?: string,
      challengeToken?: string,
    ): Promise<LoginOutcome> => {
      epochRef.current += 1;
      try {
        const result = await authLogin({
          email,
          password,
          organizationId,
          ...(challengeToken ? { challengeToken } : {}),
        });
        if ("organizationSelectionRequired" in result) {
          return {
            status: "organizationSelectionRequired",
            organizations: result.organizations,
          };
        }
        // 1-12A : nouvelle session → identité visuelle hors ligne de la
        // session précédente purgée avant l'installation du nouveau token.
        await clearTenantBrand();
        // 1-14C.2 : une session applicative remplace toute session limitée.
        clearRestrictedToken();
        setRestrictedState(null);
        setToken(result.access_token);
        const stored: StoredUser = {
          _id: result.user._id,
          name: result.user.name,
          email: result.user.email,
          role: result.user.role,
        };
        setStoredUser(stored);
        markInstalled();
        setUser(stored);
        setSessionVersion((v) => v + 1);
        return { status: "success" };
      } catch (err) {
        // 1-14C.2 : abonnement inactif → session LIMITÉE. Le JWT applicatif
        // éventuel d'une session précédente est retiré (jamais mélangé) ;
        // l'outbox locale n'est jamais touchée.
        const inactive = readSubscriptionInactive(err);
        if (inactive?.restrictedToken) {
          await clearTenantBrand();
          clearAuth();
          markInstalled();
          setUser(null);
          setRestrictedToken(inactive.restrictedToken);
          setRestrictedState(inactive.restrictedToken);
          return { status: "subscriptionInactive" };
        }
        // 1-13A : code conservé (ex. EMAIL_NOT_VERIFIED) — aucune session
        // créée, aucun token ni utilisateur stocké.
        throw new LoginError(getApiErrorMessage(err), getApiErrorCode(err));
      }
    },
    [markInstalled],
  );

  // 1-11B : purge du catalogue hors ligne AVANT de terminer la déconnexion —
  // un échec (déjà journalisé en générique par le module) ne bloque jamais
  // le logout lui-même.
  // 1-16A : appareil retiré des notifications (serveur puis navigateur,
  // best effort borné) AVANT d'effacer le jeton qui l'autorise ; hors ligne,
  // seul le désabonnement local est tenté.
  const logout = useCallback(async () => {
    epochRef.current += 1;
    await releasePushOnLogout(getToken() ?? getRestrictedToken());
    await purgeAllOfflineData();
    clearAuth();
    markInstalled();
    clearRestrictedToken();
    setRestrictedState(null);
    setUser(null);
  }, [markInstalled]);

  // 1-14C.2 — Reprise d'une session LIMITÉE : uniquement par l'échange
  // serveur (`POST /auth/subscription-access/complete`, corps vide). Le
  // nouveau JWT applicatif n'est installé que si la session limitée est
  // toujours la session courante (même jeton, même époque).
  const completeRestrictedAccess =
    useCallback(async (): Promise<RestrictedAccessOutcome> => {
      const token = getRestrictedToken();
      if (!token) {
        endRestrictedSession();
        return "expired";
      }
      const epoch = epochRef.current;
      try {
        const { access_token } = await completeSubscriptionAccess(token);
        const me = await fetchMe(access_token);
        if (epochRef.current !== epoch || getRestrictedToken() !== token) {
          return "stale";
        }
        epochRef.current += 1;
        await clearTenantBrand();
        clearRestrictedToken();
        setRestrictedState(null);
        setToken(access_token);
        const stored: StoredUser = {
          _id: me._id,
          name: me.name,
          email: me.email,
          role: me.role,
        };
        setStoredUser(stored);
        markInstalled();
        setUser(stored);
        setSessionVersion((v) => v + 1);
        return "installed";
      } catch (err) {
        if (epochRef.current !== epoch) return "stale";
        if (getApiErrorCode(err) === SUBSCRIPTION_INACTIVE) return "inactive";
        if (axios.isAxiosError(err) && err.response?.status === 401) {
          endRestrictedSession();
          return "expired";
        }
        return "unavailable";
      }
    }, [endRestrictedSession, markInstalled]);

  // 1-16G — langue du compte : envoyée une fois par session ouverte, puis à
  // chaque choix « Français / English ». Jeton applicatif ou limité de
  // CETTE session ; échec silencieux (hors connexion : au prochain envoi).
  // Aucune autre requête, aucune relance de vente ni de paiement.
  const { locale } = useLocale();
  const sentRef = useRef<string | null>(null);
  useEffect(() => {
    const token = user ? getToken() : restrictedToken;
    if (!token) return;
    const key = `${token}:${locale}`;
    if (sentRef.current === key) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    sentRef.current = key;
    updateAccountLocale(locale, token).catch(() => {
      sentRef.current = null;
    });
  }, [user, restrictedToken, sessionVersion, locale]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        sessionVersion,
        login,
        logout,
        restrictedToken,
        completeRestrictedAccess,
        endRestrictedSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
