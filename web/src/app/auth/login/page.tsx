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
import {
  INVITATION_ACCEPT_PATH,
  INVITATION_RETURN_MARKER,
  clearPendingInvitation,
  readPendingInvitation,
} from "@/lib/pending-invitation";
import {
  acceptInvitationWithCredentials,
  getApiErrorCode,
  getApiErrorMessage,
  inspectInvitationWithCredentials,
  type InvitationPreview,
} from "@/lib/api";

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
  // 1-18B : retour vers l'invitation en cours après connexion. Marqueur
  // fixe (jamais une URL lue depuis la requête) ET invitation présente dans
  // le stockage de l'onglet : aucune redirection ouverte.
  const [forInvitation, setForInvitation] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("session") === "limitee-expiree") {
      setNotice(true);
    }
    if (
      params.get("next") === INVITATION_RETURN_MARKER &&
      readPendingInvitation()
    ) {
      setForInvitation(true);
    }
  }, []);

  // 1-18B : compte SANS organisation active (connexion refusée) venu pour
  // une invitation — aperçu puis accord explicite, prouvés par les
  // identifiants saisis (aucune session ouverte avant l'adhésion).
  const [invitationPreview, setInvitationPreview] =
    useState<InvitationPreview | null>(null);
  const [invitationNotice, setInvitationNotice] = useMessage("auth");

  const inspectWithCredentials = async (): Promise<boolean> => {
    const token = readPendingInvitation();
    if (!token) return false;
    try {
      setInvitationPreview(
        await inspectInvitationWithCredentials(token, email, password),
      );
    } catch (err: unknown) {
      const code = getApiErrorCode(err);
      if (code === "INVITATION_ACCOUNT_MISMATCH") {
        setError((tr) => tr("invitation.mismatchText"));
      } else if (code === "MEMBERSHIP_ALREADY_EXISTS") {
        clearPendingInvitation();
        setError((tr) => tr("invitation.alreadyMember"));
      } else {
        if (code === "INVITATION_INVALID_OR_EXPIRED") clearPendingInvitation();
        setError(getApiErrorMessage(err));
      }
    }
    return true;
  };

  const acceptWithCredentials = async () => {
    const token = readPendingInvitation();
    if (!token || loading) return;
    setLoading(true);
    setError(null);
    try {
      await acceptInvitationWithCredentials(token, email, password);
      clearPendingInvitation();
      setForInvitation(false);
      setInvitationPreview(null);
    } catch (err: unknown) {
      setInvitationPreview(null);
      setError(getApiErrorMessage(err));
      setLoading(false);
      return;
    }
    setLoading(false);
    // Adhésion faite : connexion normale (l'organisation est désormais active).
    await submit();
  };

  const declineWithCredentials = () => {
    clearPendingInvitation();
    setForInvitation(false);
    setInvitationPreview(null);
    setPassword("");
    setInvitationNotice((tr) => tr("invitation.cancelledText"));
  };

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
      // 1-18B : l'invitation en cours s'accepte aussi avec une session
      // limitée (abonnement inactif de l'organisation courante).
      if (forInvitation && readPendingInvitation()) {
        router.push(INVITATION_ACCEPT_PATH);
        return;
      }
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
      if (
        err instanceof LoginError &&
        err.code === "ORGANIZATION_ACCESS_DENIED" &&
        forInvitation &&
        (await inspectWithCredentials())
      ) {
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

  if (invitationPreview) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-12 pb-[max(3rem,env(safe-area-inset-bottom))]">
        <div className="w-full max-w-sm space-y-6 text-center">
          <Wordmark className="mx-auto" size="large" />
          <section className="space-y-4" aria-labelledby="inv-login-title">
            <div className="space-y-1">
              <h1
                id="inv-login-title"
                className="text-lg font-semibold break-words"
              >
                {t("invitation.confirmTitle", {
                  organization: invitationPreview.organization.name,
                })}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t("invitation.confirmRole", {
                  role:
                    invitationPreview.role === "admin"
                      ? t("invitation.roles.admin")
                      : t("invitation.roles.seller"),
                })}
              </p>
              <p className="text-sm text-muted-foreground break-all">
                {t("invitation.accountLabel", { email: email.trim() })}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("invitation.noOrganizationNotice")}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                className="w-full"
                disabled={loading}
                onClick={() => void acceptWithCredentials()}
              >
                {loading ? t("invitation.accepting") : t("invitation.accept")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={loading}
                onClick={declineWithCredentials}
              >
                {t("invitation.decline")}
              </Button>
            </div>
          </section>
        </div>
      </div>
    );
  }

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

        {forInvitation && (
          <p role="status" className="text-center text-sm">
            {t("invitation.loginNotice")}
          </p>
        )}

        {invitationNotice && !error && (
          <p role="status" className="text-center text-sm">
            {invitationNotice}
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
