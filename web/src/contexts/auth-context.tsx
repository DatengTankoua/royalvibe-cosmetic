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
  login: (
    email: string,
    password: string,
    organizationId?: string,
  ) => Promise<LoginOutcome>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<StoredUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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
        return { status: "success" };
      } catch (err) {
        throw new Error(getApiErrorMessage(err));
      }
    },
    [],
  );

  const logout = useCallback(() => {
    clearAuth();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
