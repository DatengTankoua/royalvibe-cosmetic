"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "next-i18next/client";
import { useLocale } from "@/i18n/locale-provider";
import { useMessage } from "@/i18n/use-message";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NewPasswordFields } from "@/components/auth/new-password-fields";
import { USER_NAME_MAX_LENGTH } from "@/lib/name-limits";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validateNewPassword,
} from "@/lib/password-policy";

const PASSWORD_LIMITS = { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH };
import {
  acceptInvitation,
  getApiErrorCode,
  getApiErrorMessage,
  type AcceptInvitationResult,
} from "@/lib/api";
import { EmailVerificationResend } from "@/components/auth/email-verification-resend";
import { Wordmark } from "@/components/brand/wordmark";
import { TermsAcceptanceField } from "@/components/legal/terms-acceptance-field";
import {
  buildLegalAcceptance,
  legalAcceptanceErrorKey,
} from "@/lib/legal/acceptance";
import Link from "next/link";

type Step = "loading" | "needsDetails" | "success" | "error";

/** Erreur réseau (aucune réponse du serveur) : invitation non consommée. */
function isNetworkError(err: unknown): boolean {
  return axios.isAxiosError(err) && !err.response;
}

export default function AcceptInvitationPage() {
  // 1-12G : page prérendue statiquement — le token n'est JAMAIS lu pendant
  // le rendu (sinon HTML serveur « lien invalide » ≠ rendu client, erreur
  // d'hydratation et message d'erreur affiché tant que le JS n'a pas pris
  // la main). Lu une seule fois au montage, retiré de l'URL, conservé
  // uniquement en mémoire (ref) — jamais journalisé ni persisté.
  const { t } = useT("auth");
  const { t: tc } = useT("common");
  const { t: tl } = useT("legal");
  const { locale } = useLocale();
  const tokenRef = useRef<string | null>(null);
  const started = useRef(false);
  const submitting = useRef(false);
  const [step, setStep] = useState<Step>("loading");
  const [message, setMessage] = useMessage("auth");
  const [canRetry, setCanRetry] = useState(false);
  const [organizationName, setOrganizationName] = useState<string | null>(null);
  // 1-13A : vérification de l'adresse requise après acceptation (le lien
  // d'invitation n'est jamais une preuve d'accès à la boîte mail).
  const [verification, setVerification] = useState<{
    email: string;
    delivery: AcceptInvitationResult["emailVerification"]["status"];
  } | null>(null);
  const [formError, setFormError] = useMessage("auth");
  // Case non cochée signalée (message dédié, relié à la case).
  const [termsMissing, setTermsMissing] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  // 1-16C.2 : case NON cochée, demandée seulement pour CRÉER un compte. Un
  // compte existant rejoint le commerce sans acceptation enregistrée ici :
  // le lien d'invitation ne prouve pas l'identité de la personne. Son accord
  // lui est demandé après connexion.
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [loading, setLoading] = useState(false);

  const finish = (result: AcceptInvitationResult) => {
    tokenRef.current = null;
    setPassword("");
    setConfirmation("");
    setOrganizationName(result.organization.name);
    const delivery = result.emailVerification?.status ?? "not_required";
    setVerification(
      delivery === "not_required"
        ? null
        : { email: result.user.email, delivery },
    );
    setStep("success");
  };

  const fail = (err: unknown) => {
    setCanRetry(isNetworkError(err));
    setMessage(getApiErrorMessage(err));
    setStep("error");
  };

  // Premier POST { token } : un compte existant est rattaché directement ;
  // sinon ACCOUNT_DETAILS_REQUIRED (invitation NON consommée côté serveur).
  // Aucune relance automatique : « Réessayer » reste une action explicite.
  const checkInvitation = async () => {
    const token = tokenRef.current;
    if (!token || submitting.current) return;
    submitting.current = true;
    setStep("loading");
    try {
      const result = await acceptInvitation({ token });
      finish(result);
    } catch (err: unknown) {
      if (getApiErrorCode(err) === "ACCOUNT_DETAILS_REQUIRED") {
        setStep("needsDetails");
      } else {
        fail(err);
      }
    } finally {
      submitting.current = false;
    }
  };

  useEffect(() => {
    // Garde : un seul démarrage, même si l'effet est rejoué (StrictMode).
    if (started.current) return;
    started.current = true;
    tokenRef.current = new URLSearchParams(window.location.search).get("token");
    if (window.location.search || window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    if (!tokenRef.current) {
      // Token absent : aucun appel d'acceptation.
      setMessage((tr) => tr("invitation.missingToken"));
      setStep("error");
      return;
    }
    void checkInvitation();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- montage unique
  }, []);

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
      const result = await acceptInvitation({
        token,
        name,
        password,
        // 1-16G : langue des documents affichés (celle de l'interface).
        legalAcceptance: buildLegalAcceptance("invitation_account", locale),
      });
      finish(result);
    } catch (err: unknown) {
      const code = getApiErrorCode(err);
      if (code === "INVITATION_INVALID_OR_EXPIRED") {
        fail(err);
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

        {step === "loading" && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("invitation.checking")}
          </p>
        )}

        {step === "error" && (
          <>
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
            <div className="flex flex-col items-center gap-2">
              {canRetry && (
                <Button type="button" onClick={() => void checkInvitation()}>
                  {tc("actions.retry")}
                </Button>
              )}
              <Link
                href="/auth/login"
                className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                {t("login.submit")}
              </Link>
            </div>
          </>
        )}

        {step === "success" && (
          <>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">
                {t("invitation.acceptedTitle")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {verification
                  ? organizationName
                    ? t("invitation.joined", { organization: organizationName })
                    : t("invitation.acceptedTitle")
                  : organizationName
                    ? t("invitation.joinedLogin", {
                        organization: organizationName,
                      })
                    : t("invitation.loginToContinue")}
              </p>
            </div>
            {verification && (
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {t("verify.confirmToAccess")}
                </p>
                {verification.delivery === "failed" ? (
                  <p role="alert" className="text-sm text-destructive">
                    {t("invitation.deliveryFailed")}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("verify.linkSent", { email: verification.email })}
                  </p>
                )}
                <EmailVerificationResend
                  email={verification.email}
                  initialCooldown={verification.delivery !== "failed"}
                />
              </div>
            )}
            <Link
              href="/auth/login"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              {t("login.submit")}
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
              {t("invitation.finish")}
            </p>
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
              {loading ? t("invitation.submitting") : t("invitation.submit")}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
