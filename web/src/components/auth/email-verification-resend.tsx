"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  getApiErrorCode,
  isNetworkError,
  requestEmailVerification,
} from "@/lib/api";

/** Même délai que le cooldown serveur (60 s entre deux envois). */
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS = 60;

const NEUTRAL_MESSAGE =
  "Si un compte non vérifié correspond à cette adresse, un nouveau lien de confirmation vient d'être envoyé.";

function errorMessage(err: unknown): string {
  if (isNetworkError(err)) {
    return "Impossible de joindre le serveur. Vérifiez votre connexion.";
  }
  switch (getApiErrorCode(err)) {
    case "EMAIL_VERIFICATION_RATE_LIMITED":
    case "AUTH_RATE_LIMITED":
      return "Trop de demandes. Réessayez plus tard.";
    case "EMAIL_DELIVERY_UNAVAILABLE":
      return "L'envoi d'emails est momentanément indisponible. Réessayez plus tard.";
    default:
      return "La demande n'a pas pu aboutir. Réessayez plus tard.";
  }
}

interface EmailVerificationResendProps {
  email: string;
  /** Démarre avec le délai actif (un lien vient d'être envoyé). */
  initialCooldown?: boolean;
}

// 1-13A : renvoi du lien de vérification — garde de double clic (ref) et
// délai local aligné sur le cooldown serveur. Aucune donnée persistée.
export function EmailVerificationResend({
  email,
  initialCooldown = false,
}: EmailVerificationResendProps) {
  const sending = useRef(false);
  const [pending, setPending] = useState(false);
  const [remaining, setRemaining] = useState(
    initialCooldown ? EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS : 0,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);

  const resend = async () => {
    if (sending.current || remaining > 0 || !email) return;
    sending.current = true;
    setPending(true);
    setNotice(null);
    setError(null);
    try {
      await requestEmailVerification(email);
      setNotice(NEUTRAL_MESSAGE);
      setRemaining(EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS);
    } catch (err: unknown) {
      setError(errorMessage(err));
      if (!isNetworkError(err)) {
        setRemaining(EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS);
      }
    } finally {
      sending.current = false;
      setPending(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={pending || remaining > 0 || !email}
        onClick={() => void resend()}
      >
        {pending
          ? "Envoi…"
          : remaining > 0
            ? `Renvoyer l'email (${remaining} s)`
            : "Renvoyer l'email de confirmation"}
      </Button>
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
    </div>
  );
}
