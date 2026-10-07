"use client";

import { useRef, useState } from "react";
import { useT } from "next-i18next/client";
import { useLocale } from "@/i18n/locale-provider";
import { useMessage } from "@/i18n/use-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NewPasswordFields } from "@/components/auth/new-password-fields";
import {
  ORGANIZATION_NAME_MAX_LENGTH,
  USER_NAME_MAX_LENGTH,
} from "@/lib/name-limits";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validateNewPassword,
} from "@/lib/password-policy";

const PASSWORD_LIMITS = { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH };
import {
  authRegister,
  getApiErrorCode,
  getApiErrorMessage,
  type EmailVerificationDelivery,
} from "@/lib/api";
import { EmailVerificationResend } from "@/components/auth/email-verification-resend";
import { Wordmark } from "@/components/brand/wordmark";
import { BackToHome } from "@/components/landing/back-to-home";
import { AuthLegalLinks } from "@/components/legal/auth-legal-links";
import { TermsAcceptanceField } from "@/components/legal/terms-acceptance-field";
import {
  buildLegalAcceptance,
  legalAcceptanceErrorKey,
} from "@/lib/legal/acceptance";
import Link from "next/link";

export default function RegisterPage() {
  const { t } = useT("auth");
  const { t: tc } = useT("common");
  const { locale } = useLocale();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  // 1-16C.2 : case NON cochée par défaut ; jamais pré-remplie.
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [termsError, setTermsError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useMessage("auth");
  const { t: tl } = useT("legal");
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
          <BackToHome />
          <Wordmark className="mx-auto" size="large" />
          <h1 className="text-xl font-bold">{t("register.closedTitle")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("register.closedText")}
          </p>
          <Link
            href="/auth/login"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {t("login.submit")}
          </Link>
          <AuthLegalLinks />
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm space-y-4 text-center">
          <BackToHome />
          <Wordmark className="mx-auto" size="large" />
          <h1 className="text-xl font-bold">{t("register.doneTitle")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("register.doneText")}
          </p>
          <p className="text-sm font-medium">{t("verify.confirmToAccess")}</p>
          {done.delivery === "failed" ? (
            <p role="alert" className="text-sm text-destructive">
              {t("register.deliveryFailed")}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("verify.linkSent", { email: done.email })}
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
            {t("login.submit")}
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
      setError((tr) => tr(passwordError, PASSWORD_LIMITS));
      return;
    }
    // 1-16C.2 : aucune requête sans la case cochée (le serveur refuse aussi).
    if (!termsAccepted) {
      setError(null);
      setTermsError(true);
      document.getElementById("register-terms")?.focus();
      return;
    }
    setTermsError(false);
    submitting.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await authRegister({
        name,
        email,
        password,
        organizationName,
        // 1-16G : langue des documents affichés (celle de l'interface).
        legalAcceptance: buildLegalAcceptance("owner_registration", locale),
      });
      setPassword("");
      setConfirmation("");
      setDone({
        email: result.user.email,
        delivery: result.emailVerification?.status ?? "failed",
      });
    } catch (err: unknown) {
      const code = getApiErrorCode(err);
      const legalKey = legalAcceptanceErrorKey(code);
      setError(
        code === "REGISTRATION_DISABLED"
          ? (tr) => tr("register.disabled")
          : legalKey
            ? () => tl(legalKey)
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
        <BackToHome />
        <div className="space-y-3 text-center">
          <Wordmark className="mx-auto" size="large" />
          <div>
            <h1 className="text-lg font-semibold">{t("register.title")}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {t("register.subtitle")}
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="name">{t("fields.name")}</Label>
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
              {tc("fields.maxLength", { count: USER_NAME_MAX_LENGTH })}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="organizationName">
              {t("fields.organizationName")}
            </Label>
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
              {tc("fields.maxLength", { count: ORGANIZATION_NAME_MAX_LENGTH })}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">{t("fields.email")}</Label>
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

          {/* 1-16C.2 : acceptation explicite. La personne qui crée le
          commerce accepte aussi les conditions d'abonnement. Le serveur
          vérifie les versions et enregistre la preuve. */}
          <TermsAcceptanceField
            context="owner_registration"
            id="register-terms"
            checked={termsAccepted}
            onCheckedChange={(value) => {
              setTermsAccepted(value);
              if (value) setTermsError(false);
            }}
            disabled={loading}
            invalid={termsError}
            errorId={termsError ? "register-terms-error" : undefined}
          />
          {termsError && (
            <p
              id="register-terms-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {tl("acceptance.errors.required")}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? t("register.submitting") : t("register.submit")}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          {t("register.haveAccount")}{" "}
          <Link href="/auth/login" className="underline">
            {t("login.submit")}
          </Link>
        </p>
        <AuthLegalLinks />
      </div>
    </div>
  );
}
