"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "next-i18next/client";
import { useLocale } from "@/i18n/locale-provider";
import { useMessage } from "@/i18n/use-message";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NewPasswordFields } from "@/components/auth/new-password-fields";
import { Wordmark } from "@/components/brand/wordmark";
import { TermsAcceptanceField } from "@/components/legal/terms-acceptance-field";
import { USER_NAME_MAX_LENGTH } from "@/lib/name-limits";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validateNewPassword,
} from "@/lib/password-policy";
import {
  createInvitationAccount,
  getApiErrorCode,
  getApiErrorMessage,
  isNetworkError,
} from "@/lib/api";
import {
  buildLegalAcceptance,
  legalAcceptanceErrorKey,
} from "@/lib/legal/acceptance";

const PASSWORD_LIMITS = { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH };

type Step = "form" | "success" | "error";

const LINK_ACTION =
  "inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground";

// 1-18B — Création du compte d'un invité depuis le lien reçu À L'ADRESSE
// INVITÉE (jamais le lien remis au créateur) : le nom et le mot de passe
// sont choisis par la personne qui contrôle cette boîte ; l'adresse est
// alors vérifiée, sans connexion automatique. Le token est lu après le
// montage, retiré de l'URL et gardé en mémoire uniquement.
export default function CreateInvitationAccountPage() {
  const { t } = useT("auth");
  const { t: tc } = useT("common");
  const { t: tl } = useT("legal");
  const { locale } = useLocale();
  const tokenRef = useRef<string | null>(null);
  const started = useRef(false);
  const submitting = useRef(false);
  const [step, setStep] = useState<Step>("form");
  const [message, setMessage] = useMessage("auth");
  const [organizationName, setOrganizationName] = useState("");
  const [formError, setFormError] = useMessage("auth");
  const [termsMissing, setTermsMissing] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    tokenRef.current = new URLSearchParams(window.location.search).get("token");
    if (window.location.search || window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    if (!tokenRef.current) {
      setMessage((tr) => tr("invitation.create.missingToken"));
      setStep("error");
    }
  }, [setMessage]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = tokenRef.current;
    if (!token || submitting.current) return;
    // Contrôles avant soumission : aucune requête si la confirmation diffère.
    const passwordError = validateNewPassword(password, confirmation);
    if (passwordError) {
      setTermsMissing(false);
      setFormError((tr) => tr(passwordError, PASSWORD_LIMITS));
      return;
    }
    if (!termsAccepted) {
      setTermsMissing(true);
      setFormError(() => tl("acceptance.errors.required"));
      document.getElementById("inv-terms")?.focus();
      return;
    }
    submitting.current = true;
    setLoading(true);
    setTermsMissing(false);
    setFormError(null);
    try {
      // Seul `password` part à l'API ; la confirmation reste locale.
      const result = await createInvitationAccount({
        token,
        name,
        password,
        legalAcceptance: buildLegalAcceptance("invitation_account", locale),
      });
      tokenRef.current = null;
      setPassword("");
      setConfirmation("");
      setOrganizationName(result.organization.name);
      setStep("success");
    } catch (err: unknown) {
      const code = getApiErrorCode(err);
      if (code === "INVITATION_INVALID_OR_EXPIRED") {
        tokenRef.current = null;
        setMessage((tr) => tr("invitation.create.invalid"));
        setStep("error");
      } else if (code === "INVITATION_ACCOUNT_EXISTS") {
        tokenRef.current = null;
        setMessage((tr) => tr("invitation.create.exists"));
        setStep("error");
      } else if (isNetworkError(err)) {
        setFormError((tr) => tr("invitation.linkErrors.network"));
      } else {
        const legalKey = legalAcceptanceErrorKey(code);
        setFormError(legalKey ? () => tl(legalKey) : getApiErrorMessage(err));
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

        {step === "error" && (
          <section className="space-y-4">
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
            <Link href="/auth/login" className={LINK_ACTION}>
              {t("login.submit")}
            </Link>
          </section>
        )}

        {step === "success" && (
          <section className="space-y-4">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">
                {t("invitation.create.successTitle")}
              </h1>
              <p
                role="status"
                className="text-sm text-muted-foreground break-words"
              >
                {t("invitation.create.success", {
                  organization: organizationName,
                })}
              </p>
            </div>
            <Link href="/auth/login" className={LINK_ACTION}>
              {t("login.submit")}
            </Link>
          </section>
        )}

        {step === "form" && (
          <form
            onSubmit={handleSubmit}
            className="space-y-4 text-left"
            noValidate
          >
            <div className="space-y-1 text-center">
              <h1 className="text-lg font-semibold">
                {t("invitation.create.title")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t("invitation.create.text")}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="inv-name">{t("fields.name")}</Label>
              <Input
                id="inv-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
                maxLength={USER_NAME_MAX_LENGTH}
                aria-describedby="inv-name-hint"
                disabled={loading}
              />
              <p id="inv-name-hint" className="text-xs text-muted-foreground">
                {tc("fields.maxLength", { count: USER_NAME_MAX_LENGTH })}
              </p>
            </div>
            <NewPasswordFields
              idPrefix="inv-"
              password={password}
              confirmation={confirmation}
              onPasswordChange={setPassword}
              onConfirmationChange={setConfirmation}
              errorId={formError ? "inv-error" : undefined}
              disabled={loading}
            />

            <TermsAcceptanceField
              context="invitation_account"
              id="inv-terms"
              checked={termsAccepted}
              onCheckedChange={(value) => {
                setTermsAccepted(value);
                if (value) {
                  setTermsMissing(false);
                  setFormError(null);
                }
              }}
              disabled={loading}
              invalid={!termsAccepted && termsMissing}
              errorId={formError ? "inv-error" : undefined}
            />

            {formError && (
              <p
                id="inv-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {formError}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading
                ? t("invitation.create.submitting")
                : t("invitation.create.submit")}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
