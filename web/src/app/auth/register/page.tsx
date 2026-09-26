"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authRegister, getApiErrorCode, getApiErrorMessage } from "@/lib/api";
import { Wordmark } from "@/components/brand/wordmark";
import Link from "next/link";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // 0B.5 : parcours d'inscription fermé — par défaut, un accès direct à la
  // route affiche un court message (affichage seulement ; le backend est
  // l'autorité finale et refuse déjà côté API).
  const registrationEnabled =
    process.env.NEXT_PUBLIC_REGISTRATION_ENABLED === "true";

  if (!registrationEnabled) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm space-y-4 text-center">
          <Wordmark className="mx-auto text-xl font-bold" />
          <h1 className="text-xl font-bold">Inscription désactivée</h1>
          <p className="text-sm text-muted-foreground">
            L&apos;inscription en ligne est momentanément indisponible. Si tu as
            déjà un compte, connecte-toi.
          </p>
          <Link
            href="/auth/login"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Se connecter
          </Link>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm space-y-4 text-center">
          <Wordmark className="mx-auto text-xl font-bold" />
          <h1 className="text-xl font-bold">Compte créé</h1>
          <p className="text-sm text-muted-foreground">
            Ton entreprise et ton compte propriétaire ont été créés.
            Connecte-toi pour continuer.
          </p>
          <Link
            href="/auth/login"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Se connecter
          </Link>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await authRegister({ name, email, password, organizationName });
      setPassword("");
      setDone(true);
    } catch (err: unknown) {
      const code = getApiErrorCode(err);
      setError(
        code === "REGISTRATION_DISABLED"
          ? "L'inscription est actuellement désactivée."
          : getApiErrorMessage(err),
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-12 pb-[max(3rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-3 text-center">
          <Wordmark className="mx-auto text-2xl font-bold" />
          <div>
            <h1 className="text-lg font-semibold">Créer ton entreprise</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Ceci crée ton entreprise et ton compte propriétaire.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="name">Nom</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="organizationName">Nom de l&apos;entreprise</Label>
            <Input
              id="organizationName"
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
              required
              autoComplete="organization"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Mot de passe</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
              aria-describedby={error ? "register-error" : undefined}
            />
          </div>

          {error && (
            <p
              id="register-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Création…" : "Créer mon entreprise"}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          Déjà un compte ?{" "}
          <Link href="/auth/login" className="underline">
            Se connecter
          </Link>
        </p>
      </div>
    </div>
  );
}
