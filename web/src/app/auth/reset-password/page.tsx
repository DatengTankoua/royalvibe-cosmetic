"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "next-i18next/client";
import { useMessage } from "@/i18n/use-message";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/brand/wordmark";
import { NewPasswordFields } from "@/components/auth/new-password-fields";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validateNewPassword,
} from "@/lib/password-policy";

const PASSWORD_LIMITS = { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH };
import {
  confirmPasswordReset,
  getApiErrorCode,
  getApiErrorMessage,
  isNetworkError,
} from "@/lib/api";

type Step = "loading" | "form" | "success" | "invalid";

export default function ResetPasswordPage() {
  // 1-13B : même modèle que /auth/verify-email — rendu initial identique
  // serveur/navigateur (« loading »), token lu après montage, retiré de
  // l'URL, gardé en mémoire (ref) seulement. Aucune requête au simple
  // chargement. La session éventuellement ouverte n'est ni lue ni modifiée.
  const { t } = useT("auth");
  const tokenRef = useRef<string | null>(null);
  const started = useRef(false);
  const submitting = useRef(false);
  const [step, setStep] = useState<Step>("loading");
  const [message, setMessage] = useMessage("auth");
  const [formError, setFormError] = useMessage("auth");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    tokenRef.current = new URLSearchParams(window.location.search).get("token");
    if (window.location.search || window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    if (!tokenRef.current) {
      setMessage((tr) => tr("reset.missingToken"));
      setStep("invalid");
      return;
    }
    setStep("form");
  }, [setMessage]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = tokenRef.current;
    if (!token || submitting.current) return;
    // Aucune requête si la politique n'est pas respectée ou si la
    // confirmation diffère ; seul `password` part à l'API, jamais trimé.
    const passwordError = validateNewPassword(password, confirmation);
    if (passwordError) {
      setFormError((tr) => tr(passwordError, PASSWORD_LIMITS));
      return;
    }
    submitting.current = true;
    setLoading(true);
    setFormError(null);
    try {
      await confirmPasswordReset(token, password);
      tokenRef.current = null;
      setPassword("");
      setConfirmation("");
      setStep("success");
    } catch (err: unknown) {
      if (isNetworkError(err)) {
        // Nouvel essai uniquement sur action de l'utilisateur.
        setFormError((tr) => tr("reset.network"));
      } else if (getApiErrorCode(err) === "PASSWORD_RESET_INVALID_OR_EXPIRED") {
        tokenRef.current = null;
        setPassword("");
        setConfirmation("");
        setMessage((tr) => tr("reset.invalid"));
        setStep("invalid");
      } else {
        setFormError(getApiErrorMessage(err));
      }
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-12 pb-[max(3rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm space-y-6 text-center">
        <Wordmark className="mx-auto" size="large" />

        {step === "loading" && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("loading")}
          </p>
        )}

        {step === "form" && (
          <form
            onSubmit={handleSubmit}
            className="space-y-4 text-left"
            noValidate
          >
            <div className="space-y-1 text-center">
              <h1 className="text-lg font-semibold">{t("reset.title")}</h1>
              <p className="text-sm text-muted-foreground">{t("reset.text")}</p>
            </div>
            <NewPasswordFields
              idPrefix="reset-"
              password={password}
              confirmation={confirmation}
              onPasswordChange={setPassword}
              onConfirmationChange={setConfirmation}
              errorId={formError ? "reset-error" : undefined}
              disabled={loading}
            />
            {formError && (
              <p
                id="reset-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {formError}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? t("reset.submitting") : t("reset.submit")}
            </Button>
          </form>
        )}

        {step === "success" && (
          <div className="space-y-4">
            <p role="status" className="text-sm font-medium">
              {t("reset.success")}
            </p>
            <Link
              href="/auth/login"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              {t("login.submit")}
            </Link>
          </div>
        )}

        {step === "invalid" && (
          <div className="space-y-4">
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
            <Link
              href="/auth/forgot-password"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              {t("reset.newLink")}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
