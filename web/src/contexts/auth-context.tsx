"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  getToken,
  setToken,
  getStoredUser,
  setStoredUser,
  clearAuth,
  type StoredUser,
} from "@/lib/auth";
import {
  authLogin,
  getApiErrorCode,
  getApiErrorMessage,
  type SelectableOrganization,
} from "@/lib/api";
import { purgeAllOfflineData } from "@/lib/offline-purge";
import { clearTenantBrand } from "@/lib/offline-tenant-brand-db";

export type LoginOutcome =
  | { status: "success" }
  | {
      status: "organizationSelectionRequired";
      organizations: SelectableOrganization[];
    };

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
  ) => Promise<LoginOutcome>;
  logout: () => Promise<void>;
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

  useEffect(() => {
    const stored = getStoredUser();
    const token = getToken();
    if (stored && token) setUser(stored);
    setIsLoading(false);
  }, []);

  // N'accepte JAMAIS de conserver le mot de passe : il ne fait que transiter
  // vers l'appel API, aucun state du contexte ne le stocke.
  const login = useCallback(
    async (
      email: string,
      password: string,
      organizationId?: string,
    ): Promise<LoginOutcome> => {
      try {
        const result = await authLogin({ email, password, organizationId });
        if ("organizationSelectionRequired" in result) {
          return {
            status: "organizationSelectionRequired",
            organizations: result.organizations,
          };
        }
        // 1-12A : nouvelle session → identité visuelle hors ligne de la
        // session précédente purgée avant l'installation du nouveau token.
        await clearTenantBrand();
        setToken(result.access_token);
        const stored: StoredUser = {
          _id: result.user._id,
          name: result.user.name,
          email: result.user.email,
          role: result.user.role,
        };
        setStoredUser(stored);
        setUser(stored);
        setSessionVersion((v) => v + 1);
        return { status: "success" };
      } catch (err) {
        // 1-13A : code conservé (ex. EMAIL_NOT_VERIFIED) — aucune session
        // créée, aucun token ni utilisateur stocké.
        throw new LoginError(getApiErrorMessage(err), getApiErrorCode(err));
      }
    },
    [],
  );

  // 1-11B : purge du catalogue hors ligne AVANT de terminer la déconnexion —
  // un échec (déjà journalisé en générique par le module) ne bloque jamais
  // le logout lui-même.
  const logout = useCallback(async () => {
    await purgeAllOfflineData();
    clearAuth();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        sessionVersion,
        login,
        logout,
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
