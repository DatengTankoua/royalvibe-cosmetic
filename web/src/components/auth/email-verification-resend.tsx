"use client";

import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useT } from "next-i18next/client";
import { useMessage } from "@/i18n/use-message";
import { Button } from "@/components/ui/button";
import {
  getApiErrorCode,
  isNetworkError,
  requestEmailVerification,
} from "@/lib/api";

/** Même délai que le cooldown serveur (60 s entre deux envois). */
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS = 60;

function errorMessage(err: unknown) {
  return (t: TFunction<"auth">) => {
    if (isNetworkError(err)) return t("resend.errors.network");
    switch (getApiErrorCode(err)) {
      case "EMAIL_VERIFICATION_RATE_LIMITED":
      case "AUTH_RATE_LIMITED":
        return t("resend.errors.rateLimited");
      case "EMAIL_DELIVERY_UNAVAILABLE":
        return t("resend.errors.deliveryUnavailable");
      default:
        return t("resend.errors.generic");
    }
  };
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
  const { t } = useT("auth");
  const [notice, setNotice] = useState(false);
  const [error, setError] = useMessage("auth");

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);

  const resend = async () => {
    if (sending.current || remaining > 0 || !email) return;
    sending.current = true;
    setPending(true);
    setNotice(false);
    setError(null);
    try {
      await requestEmailVerification(email);
      setNotice(true);
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
          ? t("resend.sending")
          : remaining > 0
            ? t("resend.cooldown", { seconds: remaining })
            : t("resend.button")}
      </Button>
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("resend.neutral")}
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
