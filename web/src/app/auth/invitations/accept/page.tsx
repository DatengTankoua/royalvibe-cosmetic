"use client";

import { useEffect, useRef, useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  acceptInvitation,
  getApiErrorCode,
  getApiErrorMessage,
} from "@/lib/api";
import { Wordmark } from "@/components/brand/wordmark";
import Link from "next/link";

type Step = "loading" | "needsDetails" | "success" | "error";

export default function AcceptInvitationPage() {
  // Lu une seule fois au montage (pas d'effet de mirroring) — jamais loggé
  // ni persisté ailleurs qu'en mémoire du composant.
  const [token] = useState<string | null>(() =>
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("token"),
  );
  const [step, setStep] = useState<Step>(token ? "loading" : "error");
  const [message, setMessage] = useState<string>("Lien d'invitation invalide.");
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const attempted = useRef(false);

  // Retire le token de l'URL affichée (il reste en mémoire pour l'appel API).
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.search) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;
    acceptInvitation({ token })
      .then(() => setStep("success"))
      .catch((err: unknown) => {
        if (getApiErrorCode(err) === "ACCOUNT_DETAILS_REQUIRED") {
          setStep("needsDetails");
        } else {
          setMessage(getApiErrorMessage(err));
          setStep("error");
        }
      });
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setLoading(true);
    setFormError(null);
    try {
      await acceptInvitation({ token, name, password });
      setPassword("");
      setStep("success");
    } catch (err: unknown) {
      setFormError(getApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-12 pb-[max(3rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm space-y-6 text-center">
        <Wordmark className="mx-auto text-2xl font-bold" />

        {step === "loading" && (
          <p className="text-sm text-muted-foreground">
            Vérification de l&apos;invitation…
          </p>
        )}

        {step === "error" && (
          <>
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
            <Link
              href="/auth/login"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Se connecter
            </Link>
          </>
        )}

        {step === "success" && (
          <>
            <p className="text-sm text-muted-foreground">
              Invitation acceptée. Tu peux te connecter.
            </p>
            <Link
              href="/auth/login"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Se connecter
            </Link>
          </>
        )}

        {step === "needsDetails" && (
          <form
            onSubmit={handleSubmit}
            className="space-y-4 text-left"
            noValidate
          >
            <p className="text-sm text-muted-foreground text-center">
              Finalise la création de ton compte.
            </p>
            <div className="space-y-2">
              <Label htmlFor="inv-name">Nom</Label>
              <Input
                id="inv-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inv-password">Mot de passe</Label>
              <div className="relative">
                <Input
                  id="inv-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  autoComplete="new-password"
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

            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Validation…" : "Créer mon compte"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
