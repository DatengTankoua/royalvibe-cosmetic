"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/brand/wordmark";
import { NewPasswordFields } from "@/components/auth/new-password-fields";
import { validateNewPassword } from "@/lib/password-policy";
import {
  confirmPasswordReset,
  getApiErrorCode,
  getApiErrorMessage,
  isNetworkError,
} from "@/lib/api";

type Step = "loading" | "form" | "success" | "invalid";

const MISSING_TOKEN_MESSAGE =
  "Lien de réinitialisation incomplet. Ouvrez à nouveau le lien reçu par email, en entier.";
const INVALID_MESSAGE =
  "Ce lien de réinitialisation est invalide ou a expiré. Demandez un nouveau lien.";
const NETWORK_MESSAGE =
  "Impossible de joindre le serveur. Réessayez. Si la modification a pu être enregistrée, une tentative de connexion avec votre nouveau mot de passe permet de le vérifier.";

export default function ResetPasswordPage() {
  // 1-13B : même modèle que /auth/verify-email — rendu initial identique
  // serveur/navigateur (« loading »), token lu après montage, retiré de
  // l'URL, gardé en mémoire (ref) seulement. Aucune requête au simple
  // chargement. La session éventuellement ouverte n'est ni lue ni modifiée.
  const tokenRef = useRef<string | null>(null);
  const started = useRef(false);
  const submitting = useRef(false);
  const [step, setStep] = useState<Step>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
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
      setMessage(MISSING_TOKEN_MESSAGE);
      setStep("invalid");
      return;
    }
    setStep("form");
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = tokenRef.current;
    if (!token || submitting.current) return;
    // Aucune requête si la politique n'est pas respectée ou si la
    // confirmation diffère ; seul `password` part à l'API, jamais trimé.
    const passwordError = validateNewPassword(password, confirmation);
    if (passwordError) {
      setFormError(passwordError);
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
        setFormError(NETWORK_MESSAGE);
      } else if (getApiErrorCode(err) === "PASSWORD_RESET_INVALID_OR_EXPIRED") {
        tokenRef.current = null;
        setPassword("");
        setConfirmation("");
        setMessage(INVALID_MESSAGE);
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
            Chargement…
          </p>
        )}

        {step === "form" && (
          <form
            onSubmit={handleSubmit}
            className="space-y-4 text-left"
            noValidate
          >
            <div className="space-y-1 text-center">
              <h1 className="text-lg font-semibold">Nouveau mot de passe</h1>
              <p className="text-sm text-muted-foreground">
                Choisissez votre nouveau mot de passe.
              </p>
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
              {loading ? "Enregistrement…" : "Enregistrer le mot de passe"}
            </Button>
          </form>
        )}

        {step === "success" && (
          <div className="space-y-4">
            <p role="status" className="text-sm font-medium">
              Votre mot de passe a été modifié. Connectez-vous avec votre
              nouveau mot de passe.
            </p>
            <Link
              href="/auth/login"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Se connecter
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
              Demander un nouveau lien
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
