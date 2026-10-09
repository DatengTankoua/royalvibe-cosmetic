"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "next-i18next/client";
import { useMessage } from "@/i18n/use-message";
import axios from "axios";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/brand/wordmark";
import { useAuth } from "@/contexts/auth-context";
import { getToken } from "@/lib/auth";
import {
  acceptInvitation,
  fetchMe,
  getApiErrorCode,
  getApiErrorMessage,
  inspectInvitation,
  requestInvitationAccountLink,
  type InvitationPreview,
} from "@/lib/api";
import {
  LOGIN_FOR_INVITATION_PATH,
  clearPendingInvitation,
  readPendingInvitation,
  savePendingInvitation,
} from "@/lib/pending-invitation";

type Step =
  | "loading"
  | "choose"
  | "linkSent"
  | "confirm"
  | "mismatch"
  | "sessionExpired"
  | "alreadyMember"
  | "success"
  | "cancelled"
  | "error";

/** Erreur réseau (aucune réponse du serveur) : invitation non consommée. */
function isNetworkError(err: unknown): boolean {
  return axios.isAxiosError(err) && !err.response;
}

function httpStatus(err: unknown): number | undefined {
  return axios.isAxiosError(err) ? err.response?.status : undefined;
}

const LINK_ACTION =
  "inline-flex w-full items-center justify-center rounded-md px-4 py-2 text-sm font-medium";

// 1-18B — Le lien d'invitation est remis au créateur : il ne prouve ni
// l'identité de son détenteur ni le contrôle de l'adresse invitée.
// - Avec une session : aperçu, puis accord explicite. Une session d'un autre
//   compte ne rattache jamais rien (« Changer de compte »).
// - Sans session : connexion (retour ici ensuite) ou, sans compte, lien de
//   création envoyé à l'adresse invitée. La page ne révèle jamais si cette
//   adresse a déjà un compte.
// Le token est lu après le montage (page prérendue, 1-12G), retiré de l'URL
// et gardé en mémoire ; il n'est mis en `sessionStorage` que le temps d'une
// connexion, jamais dans une URL de redirection ni dans un journal.
export default function AcceptInvitationPage() {
  const { t } = useT("auth");
  const { t: tc } = useT("common");
  const router = useRouter();
  const { user, isLoading, restrictedToken, logout } = useAuth();
  const tokenRef = useRef<string | null>(null);
  const [tokenReady, setTokenReady] = useState(false);
  const checkedFor = useRef<string | null>(null);
  const busy = useRef(false);
  const [step, setStep] = useState<Step>("loading");
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [organizationName, setOrganizationName] = useState<string | null>(null);
  const [message, setMessage] = useMessage("auth");
  const [actionError, setActionError] = useMessage("auth");
  const [canRetry, setCanRetry] = useState(false);
  // Compte de la session (session limitée : aucun utilisateur stocké, lu
  // une fois sur `/auth/me`) pour reconnaître un mauvais compte.
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);

  // Session courante : JWT applicatif, sinon session limitée (abonnement
  // inactif de l'organisation courante — sans effet sur l'invitation).
  const sessionToken = user ? getToken() : restrictedToken;

  // Fin du parcours : le token quitte la mémoire et le stockage d'onglet.
  const forgetToken = useCallback(() => {
    tokenRef.current = null;
    clearPendingInvitation();
  }, []);

  const fail = useCallback(
    (err: unknown) => {
      setCanRetry(isNetworkError(err));
      if (!isNetworkError(err)) clearPendingInvitation();
      setMessage(getApiErrorMessage(err));
      setStep("error");
    },
    [setMessage],
  );

  const check = useCallback(async () => {
    const token = tokenRef.current;
    if (!token) return;
    if (!sessionToken) {
      setStep("choose");
      return;
    }
    setStep("loading");
    if (user) setSessionEmail(user.email);
    else
      fetchMe(sessionToken)
        .then((me) => setSessionEmail(me.email))
        .catch(() => setSessionEmail(null));
    try {
      setPreview(await inspectInvitation(token, sessionToken));
      setStep("confirm");
    } catch (err: unknown) {
      const code = getApiErrorCode(err);
      if (code === "INVITATION_ACCOUNT_MISMATCH") setStep("mismatch");
      else if (code === "MEMBERSHIP_ALREADY_EXISTS") {
        forgetToken();
        setStep("alreadyMember");
      } else if (httpStatus(err) === 401) setStep("sessionExpired");
      else fail(err);
    }
  }, [sessionToken, user, fail, forgetToken]);

  // Lecture unique du token : URL (retirée aussitôt), sinon retour de
  // connexion (stockage d'onglet).
  useEffect(() => {
    if (tokenRef.current !== null || tokenReady) return;
    const fromUrl = new URLSearchParams(window.location.search).get("token");
    if (window.location.search || window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    if (fromUrl) clearPendingInvitation();
    tokenRef.current = fromUrl ?? readPendingInvitation();
    setTokenReady(true);
    if (!tokenRef.current) {
      setMessage((tr) => tr("invitation.missingToken"));
      setStep("error");
    }
  }, [tokenReady, setMessage]);

  // Vérification après la restauration de la session, une fois par session.
  useEffect(() => {
    if (!tokenReady || isLoading || !tokenRef.current) return;
    const key = sessionToken ?? "";
    if (checkedFor.current === key) return;
    checkedFor.current = key;
    void check();
  }, [tokenReady, isLoading, sessionToken, check]);

  const goToLogin = async (switchAccount: boolean) => {
    const token = tokenRef.current;
    if (!token || busy.current) return;
    busy.current = true;
    try {
      savePendingInvitation(token);
      if (switchAccount) await logout();
      router.push(LOGIN_FOR_INVITATION_PATH);
    } finally {
      busy.current = false;
    }
  };

  const requestLink = async () => {
    const token = tokenRef.current;
    if (!token || busy.current) return;
    busy.current = true;
    setPending(true);
    setActionError(null);
    try {
      await requestInvitationAccountLink(token);
      forgetToken();
      setStep("linkSent");
    } catch (err: unknown) {
      const code = getApiErrorCode(err);
      if (code === "INVITATION_INVALID_OR_EXPIRED") fail(err);
      else
        setActionError((tr) =>
          isNetworkError(err)
            ? tr("invitation.linkErrors.network")
            : code === "AUTH_RATE_LIMITED"
              ? tr("invitation.linkErrors.rateLimited")
              : code === "EMAIL_DELIVERY_UNAVAILABLE"
                ? tr("invitation.linkErrors.deliveryUnavailable")
                : tr("invitation.linkErrors.generic"),
        );
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const accept = async () => {
    const token = tokenRef.current;
    if (!token || !sessionToken || busy.current) return;
    busy.current = true;
    setPending(true);
    setActionError(null);
    try {
      const result = await acceptInvitation(token, sessionToken);
      forgetToken();
      setOrganizationName(result.organization.name);
      setStep("success");
    } catch (err: unknown) {
      const code = getApiErrorCode(err);
      if (code === "INVITATION_ACCOUNT_MISMATCH") setStep("mismatch");
      else if (code === "MEMBERSHIP_ALREADY_EXISTS") {
        forgetToken();
        setStep("alreadyMember");
      } else if (httpStatus(err) === 401) setStep("sessionExpired");
      else if (isNetworkError(err))
        setActionError((tr) => tr("invitation.acceptError"));
      else fail(err);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  // Annulation : rien n'est envoyé, l'invitation reste valable.
  const cancel = () => {
    forgetToken();
    setStep("cancelled");
  };

  const reconnect = async () => {
    await logout();
    router.push("/auth/login");
  };

  const roleLabel = (role: InvitationPreview["role"]) =>
    role === "admin"
      ? t("invitation.roles.admin")
      : t("invitation.roles.seller");

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-12 pb-[max(3rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm space-y-6 text-center">
        <Wordmark className="mx-auto" size="large" />

        {step === "loading" && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("invitation.checking")}
          </p>
        )}

        {step === "choose" && (
          <section className="space-y-4" aria-labelledby="inv-choose-title">
            <div className="space-y-1">
              <h1 id="inv-choose-title" className="text-lg font-semibold">
                {t("invitation.chooseTitle")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t("invitation.chooseText")}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                className="w-full"
                disabled={pending}
                onClick={() => void goToLogin(false)}
              >
                {t("invitation.loginToAccept")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={pending}
                onClick={() => void requestLink()}
              >
                {pending
                  ? t("invitation.sendingLink")
                  : t("invitation.noAccount")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                disabled={pending}
                onClick={cancel}
              >
                {t("invitation.cancel")}
              </Button>
            </div>
            {actionError && (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            )}
          </section>
        )}

        {step === "linkSent" && (
          <section className="space-y-4" aria-labelledby="inv-sent-title">
            <div className="space-y-2">
              <h1 id="inv-sent-title" className="text-lg font-semibold">
                {t("invitation.linkSentTitle")}
              </h1>
              <p role="status" className="text-sm text-muted-foreground">
                {t("invitation.linkSent")}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("invitation.linkSentExisting")}
              </p>
            </div>
            <Link
              href="/auth/login"
              className={`${LINK_ACTION} bg-primary text-primary-foreground`}
            >
              {t("login.submit")}
            </Link>
          </section>
        )}

        {step === "confirm" && preview && (
          <section className="space-y-4" aria-labelledby="inv-confirm-title">
            <div className="space-y-1">
              <h1
                id="inv-confirm-title"
                className="text-lg font-semibold break-words"
              >
                {t("invitation.confirmTitle", {
                  organization: preview.organization.name,
                })}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t("invitation.confirmRole", {
                  role: roleLabel(preview.role),
                })}
              </p>
              {sessionEmail && (
                <p className="text-sm text-muted-foreground break-all">
                  {t("invitation.signedInAs", { email: sessionEmail })}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                className="w-full"
                disabled={pending}
                onClick={() => void accept()}
              >
                {pending ? t("invitation.accepting") : t("invitation.accept")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={pending}
                onClick={cancel}
              >
                {t("invitation.decline")}
              </Button>
            </div>
            {actionError && (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            )}
          </section>
        )}

        {step === "mismatch" && (
          <section className="space-y-4" aria-labelledby="inv-mismatch-title">
            <div className="space-y-1">
              <h1 id="inv-mismatch-title" className="text-lg font-semibold">
                {t("invitation.mismatchTitle")}
              </h1>
              <p role="alert" className="text-sm text-muted-foreground">
                {t("invitation.mismatchText")}
              </p>
              {sessionEmail && (
                <p className="text-sm text-muted-foreground break-all">
                  {t("invitation.signedInAs", { email: sessionEmail })}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                className="w-full"
                onClick={() => void goToLogin(true)}
              >
                {t("invitation.switchAccount")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={cancel}
              >
                {t("invitation.cancel")}
              </Button>
            </div>
          </section>
        )}

        {step === "sessionExpired" && (
          <section className="space-y-4">
            <p role="alert" className="text-sm text-muted-foreground">
              {t("invitation.sessionExpired")}
            </p>
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                className="w-full"
                onClick={() => void goToLogin(true)}
              >
                {t("invitation.loginToAccept")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={cancel}
              >
                {t("invitation.cancel")}
              </Button>
            </div>
          </section>
        )}

        {step === "alreadyMember" && (
          <section className="space-y-4">
            <p role="status" className="text-sm text-muted-foreground">
              {t("invitation.alreadyMember")}
            </p>
            <Link
              href="/app"
              className={`${LINK_ACTION} bg-primary text-primary-foreground`}
            >
              {t("invitation.openApp")}
            </Link>
          </section>
        )}

        {step === "success" && (
          <section className="space-y-4">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">
                {t("invitation.acceptedTitle")}
              </h1>
              <p
                role="status"
                className="text-sm text-muted-foreground break-words"
              >
                {organizationName
                  ? t("invitation.joined", { organization: organizationName })
                  : t("invitation.acceptedTitle")}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("invitation.joinedSwitch")}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                className="w-full"
                onClick={() => void reconnect()}
              >
                {t("invitation.reconnect")}
              </Button>
              <Link
                href="/app"
                className={`${LINK_ACTION} border border-input bg-background`}
              >
                {t("invitation.openApp")}
              </Link>
            </div>
          </section>
        )}

        {step === "cancelled" && (
          <section className="space-y-4">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">
                {t("invitation.cancelledTitle")}
              </h1>
              <p role="status" className="text-sm text-muted-foreground">
                {t("invitation.cancelledText")}
              </p>
            </div>
            <Link
              href={user ? "/app" : "/"}
              className={`${LINK_ACTION} border border-input bg-background`}
            >
              {user ? t("invitation.openApp") : t("invitation.backHome")}
            </Link>
          </section>
        )}

        {step === "error" && (
          <>
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
            <div className="flex flex-col items-center gap-2">
              {canRetry && (
                <Button type="button" onClick={() => void check()}>
                  {tc("actions.retry")}
                </Button>
              )}
              <Link
                href={user ? "/app" : "/auth/login"}
                className={`${LINK_ACTION} bg-primary text-primary-foreground`}
              >
                {user ? t("invitation.openApp") : t("login.submit")}
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
