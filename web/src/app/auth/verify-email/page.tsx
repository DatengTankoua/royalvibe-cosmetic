"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "next-i18next/client";
import { useMessage } from "@/i18n/use-message";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/brand/wordmark";
import {
  confirmEmailVerification,
  getApiErrorCode,
  isNetworkError,
} from "@/lib/api";

type Step =
  "loading" | "ready" | "submitting" | "success" | "invalid" | "retry";

export default function VerifyEmailPage() {
  // 1-13A : rendu initial identique serveur/navigateur (« loading ») — le
  // token n'est JAMAIS lu pendant le rendu. Lu une seule fois après montage,
  // retiré de l'URL, conservé uniquement en mémoire (ref) : jamais journalisé
  // ni persisté (localStorage, sessionStorage, IndexedDB, Cache Storage).
  // Aucun changement d'état au simple chargement : la confirmation exige
  // un clic explicite. La session éventuellement ouverte n'est jamais lue
  // ni modifiée ici.
  const { t } = useT("auth");
  const tokenRef = useRef<string | null>(null);
  const started = useRef(false);
  const submitting = useRef(false);
  const [step, setStep] = useState<Step>("loading");
  const [message, setMessage] = useMessage("auth");

  useEffect(() => {
    // Garde : un seul démarrage, même si l'effet est rejoué (StrictMode).
    if (started.current) return;
    started.current = true;
    tokenRef.current = new URLSearchParams(window.location.search).get("token");
    if (window.location.search || window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    if (!tokenRef.current) {
      setMessage((tr) => tr("verify.missingToken"));
      setStep("invalid");
      return;
    }
    setStep("ready");
  }, [setMessage]);

  const confirm = async () => {
    const token = tokenRef.current;
    if (!token || submitting.current) return;
    submitting.current = true;
    setStep("submitting");
    setMessage(null);
    try {
      await confirmEmailVerification(token);
      tokenRef.current = null;
      setStep("success");
    } catch (err: unknown) {
      if (isNetworkError(err)) {
        // Nouvel essai uniquement sur action de l'utilisateur.
        setMessage((tr) => tr("verify.network"));
        setStep("retry");
      } else if (
        getApiErrorCode(err) === "EMAIL_VERIFICATION_INVALID_OR_EXPIRED"
      ) {
        tokenRef.current = null;
        setMessage((tr) => tr("verify.invalid"));
        setStep("invalid");
      } else {
        // Limitation (429) ou erreur serveur : le lien reste utilisable.
        setMessage((tr) => tr("verify.failed"));
        setStep("retry");
      }
    } finally {
      submitting.current = false;
    }
  };

  const loginLink = (
    <Link
      href="/auth/login"
      className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
    >
      {t("login.submit")}
    </Link>
  );

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-12 pb-[max(3rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm space-y-6 text-center">
        <Wordmark className="mx-auto" size="large" />

        {step === "loading" && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("loading")}
          </p>
        )}

        {(step === "ready" || step === "submitting" || step === "retry") && (
          <div className="space-y-4">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">{t("verify.title")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("verify.text")}
              </p>
            </div>
            {message && (
              <p role="alert" className="text-sm text-destructive">
                {message}
              </p>
            )}
            <Button
              type="button"
              className="w-full"
              disabled={step === "submitting"}
              onClick={() => void confirm()}
            >
              {step === "submitting"
                ? t("verify.submitting")
                : t("verify.metaTitle")}
            </Button>
          </div>
        )}

        {step === "success" && (
          <div className="space-y-4">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">
                {t("verify.successTitle")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t("verify.successText")}
              </p>
            </div>
            {loginLink}
          </div>
        )}

        {step === "invalid" && (
          <div className="space-y-4">
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
            {loginLink}
          </div>
        )}
      </div>
    </div>
  );
}
