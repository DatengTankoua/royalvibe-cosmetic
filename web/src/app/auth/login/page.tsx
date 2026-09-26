"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/auth-context";
import type { SelectableOrganization } from "@/lib/api";
import { Wordmark } from "@/components/brand/wordmark";
import Link from "next/link";

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [organizations, setOrganizations] = useState<
    SelectableOrganization[] | null
  >(null);
  // 0B.5 : masque le lien d'inscription (affichage seulement — le backend
  // reste l'autorité finale). Par défaut : désactivée.
  const registrationEnabled =
    process.env.NEXT_PUBLIC_REGISTRATION_ENABLED === "true";

  const submit = async (organizationId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const outcome = await login(email, password, organizationId);
      if (outcome.status === "organizationSelectionRequired") {
        setOrganizations(outcome.organizations);
        return;
      }
      setPassword("");
      router.push("/app");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Erreur de connexion");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const handleBack = () => {
    setOrganizations(null);
    setPassword("");
    setError(null);
  };

  if (organizations) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-12 pb-[max(3rem,env(safe-area-inset-bottom))]">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-3 text-center">
            <Wordmark className="text-xl font-bold" />
            <p className="text-sm text-muted-foreground">
              Choisis l&apos;organisation à laquelle te connecter
            </p>
          </div>

          {error && (
            <p role="alert" className="text-center text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="space-y-2">
            {organizations.map((org) => (
              <button
                key={org.organizationId}
                type="button"
                disabled={loading}
                onClick={() => void submit(org.organizationId)}
                className="w-full rounded-md border px-4 py-2.5 text-left text-sm font-medium hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
              >
                {org.name}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleBack}
            className="w-full text-center text-sm text-muted-foreground underline underline-offset-2"
          >
            Retour
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-12 pb-[max(3rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-3 text-center">
          <Wordmark className="text-2xl font-bold" />
          <p className="text-sm text-muted-foreground">
            Connexion à ton espace de gestion
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              aria-describedby={error ? "login-error" : undefined}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Mot de passe</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                aria-describedby={error ? "login-error" : undefined}
                className="pr-9"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={
                  showPassword
                    ? "Masquer le mot de passe"
                    : "Afficher le mot de passe"
                }
                aria-pressed={showPassword}
                className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
              >
                {showPassword ? (
                  <EyeOffIcon className="h-4 w-4" />
                ) : (
                  <EyeIcon className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          {error && (
            <p
              id="login-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Connexion…" : "Se connecter"}
          </Button>
        </form>

        {registrationEnabled && (
          <p className="text-center text-sm text-muted-foreground">
            Pas encore de compte ?{" "}
            <Link href="/auth/register" className="underline">
              S&apos;inscrire
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
