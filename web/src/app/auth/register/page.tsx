"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NewPasswordFields } from "@/components/auth/new-password-fields";
import {
  ORGANIZATION_NAME_HINT,
  ORGANIZATION_NAME_MAX_LENGTH,
  USER_NAME_HINT,
  USER_NAME_MAX_LENGTH,
} from "@/lib/name-limits";
import { validateNewPassword } from "@/lib/password-policy";
import {
  authRegister,
  getApiErrorCode,
  getApiErrorMessage,
  type EmailVerificationDelivery,
} from "@/lib/api";
import { EmailVerificationResend } from "@/components/auth/email-verification-resend";
import { Wordmark } from "@/components/brand/wordmark";
import Link from "next/link";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 1-13A : compte créé (adresse enregistrée + résultat de l'envoi du lien).
  const [done, setDone] = useState<{
    email: string;
    delivery: EmailVerificationDelivery;
  } | null>(null);
  const submitting = useRef(false);
  // 0B.5 : parcours d'inscription fermé — par défaut, un accès direct à la
  // route affiche un court message (affichage seulement ; le backend est
  // l'autorité finale et refuse déjà côté API).
  const registrationEnabled =
    process.env.NEXT_PUBLIC_REGISTRATION_ENABLED === "true";

  if (!registrationEnabled) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm space-y-4 text-center">
          <Wordmark className="mx-auto" size="large" />
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
          <Wordmark className="mx-auto" size="large" />
          <h1 className="text-xl font-bold">Compte créé</h1>
          <p className="text-sm text-muted-foreground">
            Ton entreprise et ton compte propriétaire ont été créés.
          </p>
          <p className="text-sm font-medium">
            Confirmez votre adresse email pour accéder à votre compte.
          </p>
          {done.delivery === "failed" ? (
            <p role="alert" className="text-sm text-destructive">
              L&apos;email de confirmation n&apos;a pas pu être envoyé. Ton
              compte est bien créé : demande un nouvel envoi ci-dessous.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Un lien de confirmation a été envoyé à {done.email}.
            </p>
          )}
          <EmailVerificationResend
            email={done.email}
            initialCooldown={done.delivery !== "failed"}
          />
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
    if (submitting.current) return;
    // 1-12G : aucune requête si le mot de passe ne respecte pas la politique
    // ou si la confirmation diffère ; seul `password` part à l'API.
    const passwordError = validateNewPassword(password, confirmation);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    submitting.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await authRegister({
        name,
        email,
        password,
        organizationName,
      });
      setPassword("");
      setConfirmation("");
      setDone({
        email: result.user.email,
        delivery: result.emailVerification?.status ?? "failed",
      });
    } catch (err: unknown) {
      const code = getApiErrorCode(err);
      setError(
        code === "REGISTRATION_DISABLED"
          ? "L'inscription est actuellement désactivée."
          : getApiErrorMessage(err),
      );
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-12 pb-[max(3rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-3 text-center">
          <Wordmark className="mx-auto" size="large" />
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
              maxLength={USER_NAME_MAX_LENGTH}
              aria-describedby="name-hint"
            />
            <p id="name-hint" className="text-xs text-muted-foreground">
              {USER_NAME_HINT}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="organizationName">Nom de l&apos;entreprise</Label>
            <Input
              id="organizationName"
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
              required
              autoComplete="organization"
              maxLength={ORGANIZATION_NAME_MAX_LENGTH}
              aria-describedby="organizationName-hint"
            />
            <p
              id="organizationName-hint"
              className="text-xs text-muted-foreground"
            >
              {ORGANIZATION_NAME_HINT}
            </p>
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
          <NewPasswordFields
            idPrefix=""
            password={password}
            confirmation={confirmation}
            onPasswordChange={setPassword}
            onConfirmationChange={setConfirmation}
            errorId={error ? "register-error" : undefined}
            disabled={loading}
          />

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
