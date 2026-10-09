"use client";

import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useT } from "next-i18next/client";
import { useMessage } from "@/i18n/use-message";
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
import { TurnstileWidget } from "@/components/auth/turnstile-widget";

/** Même délai que le cooldown serveur (60 s entre deux envois). */
const COOLDOWN_SECONDS = 60;

function errorMessage(err: unknown) {
  return (t: TFunction<"auth">) => {
    if (isNetworkError(err)) return t("forgot.errors.network");
    switch (getApiErrorCode(err)) {
      case "PASSWORD_RESET_RATE_LIMITED":
      case "AUTH_RATE_LIMITED":
        return t("resend.errors.rateLimited");
      case "EMAIL_DELIVERY_UNAVAILABLE":
        return t("resend.errors.deliveryUnavailable");
      case "TURNSTILE_REQUIRED":
      case "TURNSTILE_FAILED":
        return t("resend.errors.antiBotFailed");
      case "TURNSTILE_UNAVAILABLE":
        return t("resend.errors.antiBotUnavailable");
      default:
        return t("forgot.errors.generic");
    }
  };
}

// 1-13B : demande de réinitialisation — réponse neutre identique pour tout
// compte, garde synchrone contre le double clic, délai local de 60 s, aucun
// nouvel essai automatique. L'adresse n'est jamais persistée.
export default function ForgotPasswordPage() {
  const { t } = useT("auth");
  const sending = useRef(false);
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [notice, setNotice] = useState(false);
  const [error, setError] = useMessage("auth");
  // 1-18D : vérification anti-robot (action `password-reset`), neuve pour
  // chaque demande ; renouvelée après usage ou expiration.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileReset, setTurnstileReset] = useState(0);

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
      setError((tr) => tr("forgot.emailRequired"));
      return;
    }
    if (!turnstileToken) {
      setError((tr) => tr("resend.errors.antiBotRequired"));
      return;
    }
    const token = turnstileToken;
    setTurnstileToken(null);
    setTurnstileReset((n) => n + 1);
    sending.current = true;
    setPending(true);
    setNotice(false);
    setError(null);
    try {
      await requestPasswordReset(address, token);
      setNotice(true);
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
            <h1 className="text-lg font-semibold">{t("forgot.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("forgot.text")}
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="email">{t("fields.email")}</Label>
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

          <TurnstileWidget
            action="password-reset"
            onToken={setTurnstileToken}
            resetSignal={turnstileReset}
            disabled={pending}
          />

          {notice && (
            <p role="status" className="text-sm text-muted-foreground">
              {t("forgot.neutral")}
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
              ? t("resend.sending")
              : remaining > 0
                ? t("forgot.cooldown", { seconds: remaining })
                : t("forgot.submit")}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          <Link href="/auth/login" className="underline">
            {t("forgot.backToLogin")}
          </Link>
        </p>
      </div>
    </div>
  );
}
