"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Wordmark } from "@/components/brand/wordmark";
import {
  getApiErrorCode,
  isNetworkError,
  requestPasswordReset,
} from "@/lib/api";

/** Même délai que le cooldown serveur (60 s entre deux envois). */
const COOLDOWN_SECONDS = 60;

const NEUTRAL_MESSAGE =
  "Si un compte correspond à cette adresse, vous recevrez un lien pour réinitialiser votre mot de passe.";

function errorMessage(err: unknown): string {
  if (isNetworkError(err)) {
    return "Impossible de joindre le serveur. Vérifiez votre connexion puis réessayez.";
  }
  switch (getApiErrorCode(err)) {
    case "PASSWORD_RESET_RATE_LIMITED":
    case "AUTH_RATE_LIMITED":
      return "Trop de demandes. Réessayez plus tard.";
    case "EMAIL_DELIVERY_UNAVAILABLE":
      return "L'envoi d'emails est momentanément indisponible. Réessayez plus tard.";
    default:
      return "Vérifiez l'adresse email saisie puis réessayez.";
  }
}

// 1-13B : demande de réinitialisation — réponse neutre identique pour tout
// compte, garde synchrone contre le double clic, délai local de 60 s, aucun
// nouvel essai automatique. L'adresse n'est jamais persistée.
export default function ForgotPasswordPage() {
  const sending = useRef(false);
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending.current || remaining > 0) return;
    const address = email.trim();
    if (!address) {
      setError("Saisissez votre adresse email.");
      return;
    }
    sending.current = true;
    setPending(true);
    setNotice(null);
    setError(null);
    try {
      await requestPasswordReset(address);
      setNotice(NEUTRAL_MESSAGE);
      setRemaining(COOLDOWN_SECONDS);
    } catch (err: unknown) {
      setError(errorMessage(err));
      const code = getApiErrorCode(err);
      if (
        code === "PASSWORD_RESET_RATE_LIMITED" ||
        code === "AUTH_RATE_LIMITED"
      ) {
        setRemaining(COOLDOWN_SECONDS);
      }
    } finally {
      sending.current = false;
      setPending(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-12 pb-[max(3rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-3 text-center">
          <Wordmark className="mx-auto" size="large" />
          <div>
            <h1 className="text-lg font-semibold">Mot de passe oublié</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Indiquez votre adresse email : nous vous enverrons un lien pour
              choisir un nouveau mot de passe.
            </p>
          </div>
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
              disabled={pending}
            />
          </div>

          {notice && (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={pending || remaining > 0}
          >
            {pending
              ? "Envoi…"
              : remaining > 0
                ? `Envoyer le lien (${remaining} s)`
                : "Envoyer le lien"}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          <Link href="/auth/login" className="underline">
            Retour à la connexion
          </Link>
        </p>
      </div>
    </div>
  );
}
