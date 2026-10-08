"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useT } from "next-i18next/client";
import { useMessage } from "@/i18n/use-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoginError, useAuth } from "@/contexts/auth-context";
import { EmailVerificationResend } from "@/components/auth/email-verification-resend";
import { AuthLegalLinks } from "@/components/legal/auth-legal-links";
import type { SelectableOrganization } from "@/lib/api";
import { Wordmark } from "@/components/brand/wordmark";
import { BackToHome } from "@/components/landing/back-to-home";
import Link from "next/link";

export default function LoginPage() {
  const { t } = useT("auth");
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useMessage("auth");
  // 1-13A : identifiants corrects mais adresse non vérifiée — aucune session
  // créée ; l'adresse saisie sert uniquement au renvoi du lien.
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [organizations, setOrganizations] = useState<
    SelectableOrganization[] | null
  >(null);
  // 0B.5 : masque le lien d'inscription (affichage seulement — le backend
  // reste l'autorité finale). Par défaut : désactivée.
  const registrationEnabled =
    process.env.NEXT_PUBLIC_REGISTRATION_ENABLED === "true";
  // 1-14C.2 : retour d'une session limitée expirée (message seul, aucune
  // donnée lue dans l'URL au-delà de ce marqueur).
  const [notice, setNotice] = useState(false);
  useEffect(() => {
    if (
      new URLSearchParams(window.location.search).get("session") ===
      "limitee-expiree"
    ) {
      setNotice(true);
    }
  }, []);

  const submit = async (organizationId?: string) => {
    setLoading(true);
    setError(null);
    setUnverifiedEmail(null);
    try {
      const outcome = await login(email, password, organizationId);
      if (outcome.status === "organizationSelectionRequired") {
        setOrganizations(outcome.organizations);
        return;
      }
      setPassword("");
      // 1-14C.2 : abonnement inactif → écran d'accès limité (hors /app).
      router.push(
        outcome.status === "subscriptionInactive" ? "/access" : "/app",
      );
    } catch (err: unknown) {
      if (err instanceof LoginError && err.code === "EMAIL_NOT_VERIFIED") {
        setOrganizations(null);
        setUnverifiedEmail(email.trim());
        return;
      }
      // Message de l'API déjà dans la langue de la requête.
      setError(
        err instanceof Error ? err.message : (tr) => tr("login.errors.generic"),
      );
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const handleBack = () => {
    setOrganizations(null);
    setPassword("");
    setError(null);
  };

  if (organizations) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-12 pb-[max(3rem,env(safe-area-inset-bottom))]">
        <div className="w-full max-w-sm space-y-6">
          <BackToHome />
          <div className="space-y-3 text-center">
            <Wordmark className="mx-auto" size="large" />
            <p className="text-sm text-muted-foreground">
              {t("login.chooseOrganization")}
            </p>
          </div>

          {error && (
            <p role="alert" className="text-center text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="space-y-2">
            {organizations.map((org) => (
              <button
                key={org.organizationId}
                type="button"
                disabled={loading}
                onClick={() => void submit(org.organizationId)}
                className="w-full rounded-md border px-4 py-2.5 text-left text-sm font-medium hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
              >
                {org.name}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleBack}
            className="w-full text-center text-sm text-muted-foreground underline underline-offset-2"
          >
            {t("login.back")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-12 pb-[max(3rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm space-y-6">
        <BackToHome />
        <div className="space-y-3 text-center">
          <Wordmark className="mx-auto" size="large" />
          <p className="text-sm text-muted-foreground">{t("login.subtitle")}</p>
        </div>

        {notice && !error && (
          <p role="status" className="text-center text-sm">
            {t("login.limitedExpired")}
          </p>
        )}

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
              aria-describedby={error ? "login-error" : undefined}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t("password.label")}</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                aria-describedby={error ? "login-error" : undefined}
                className="pr-9"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={
                  showPassword ? t("password.hide") : t("password.show")
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

          <div className="text-right">
            <Link
              href="/auth/forgot-password"
              className="text-sm text-muted-foreground underline underline-offset-2"
            >
              {t("login.forgot")}
            </Link>
          </div>

          {error && (
            <p
              id="login-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? t("login.submitting") : t("login.submit")}
          </Button>
        </form>

        {unverifiedEmail && (
          <div
            role="alert"
            className="space-y-3 rounded-md border px-4 py-3 text-sm"
          >
            <p className="font-medium">{t("login.unverifiedTitle")}</p>
            <p className="text-muted-foreground">{t("login.unverifiedText")}</p>
            <EmailVerificationResend email={unverifiedEmail} />
          </div>
        )}

        {registrationEnabled && (
          <p className="text-center text-sm text-muted-foreground">
            {t("login.noAccount")}{" "}
            <Link href="/auth/register" className="underline">
              {t("login.signUp")}
            </Link>
          </p>
        )}
        <AuthLegalLinks />
      </div>
    </div>
  );
}
