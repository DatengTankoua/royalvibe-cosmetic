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
import { authLogin, authRegister, getApiErrorMessage } from "@/lib/api";

interface AuthContextValue {
  user: StoredUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
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

  const login = useCallback(async (email: string, password: string) => {
    try {
      const { access_token, user: u } = await authLogin({ email, password });
      setToken(access_token);
      const stored: StoredUser = {
        _id: u._id,
        name: u.name,
        email: u.email,
        role: u.role,
      };
      setStoredUser(stored);
      setUser(stored);
    } catch (err) {
      throw new Error(getApiErrorMessage(err));
    }
  }, []);

  const register = useCallback(
    async (name: string, email: string, password: string) => {
      try {
        const { access_token, user: u } = await authRegister({
          name,
          email,
          password,
        });
        setToken(access_token);
        const stored: StoredUser = {
          _id: u._id,
          name: u.name,
          email: u.email,
          role: u.role,
        };
        setStoredUser(stored);
        setUser(stored);
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
    <AuthContext.Provider value={{ user, isLoading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
