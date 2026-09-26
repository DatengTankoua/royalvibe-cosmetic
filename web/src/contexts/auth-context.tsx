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
  switchOrganization as apiSwitchOrganization,
  getApiErrorMessage,
  type SelectableOrganization,
} from "@/lib/api";

export type LoginOutcome =
  | { status: "success" }
  | {
      status: "organizationSelectionRequired";
      organizations: SelectableOrganization[];
    };

interface AuthContextValue {
  user: StoredUser | null;
  isLoading: boolean;
  // Incrémenté à chaque changement de JWT (login réussi, switch
  // d'organisation) — permet à useSocket() de forcer une reconnexion.
  sessionVersion: number;
  login: (
    email: string,
    password: string,
    organizationId?: string,
  ) => Promise<LoginOutcome>;
  switchOrganization: (organizationId: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

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
        throw new Error(getApiErrorMessage(err));
      }
    },
    [],
  );

  // Le token précédent n'est JAMAIS effacé avant réception du nouveau : si
  // l'appel échoue, l'ancien token/organisation restent intacts.
  const switchOrganization = useCallback(async (organizationId: string) => {
    try {
      const { access_token } = await apiSwitchOrganization(organizationId);
      setToken(access_token);
      setSessionVersion((v) => v + 1);
    } catch (err) {
      throw new Error(getApiErrorMessage(err));
    }
  }, []);

  const logout = useCallback(() => {
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
        switchOrganization,
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
