"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import axios from "axios";
import { useT } from "next-i18next/client";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";
import { useMessage } from "@/i18n/use-message";
import { useAuth } from "@/contexts/auth-context";
import { Wordmark } from "@/components/brand/wordmark";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { CommercialBlockScreen } from "@/components/subscription/commercial-block-screen";
import {
  fetchActiveOrganizations,
  fetchAuthContext,
  type ApiAuthContext,
} from "@/lib/api";
import {
  getRestrictedToken,
  hasStoredRestrictedToken,
} from "@/lib/restricted-session";
import { writeIdentityPointer } from "@/lib/offline-identity-db";
import { fullNameOf } from "@/lib/display-names";

// 1-14C.2 — Session LIMITÉE (abonnement du commerce inactif).
//
// Route HORS du shell /app : aucun hook métier, aucune navigation métier,
// aucun appel de branding protégé, aucun socket, aucun moteur de
// synchronisation. Appels autorisés uniquement, avec le jeton limité
// EXPLICITE : contexte/état d'accès, liste de ses organisations (nom),
// abonnement (propriétaire réel), échange de reprise.

const EXPIRED_LOGIN_URL = "/auth/login?session=limitee-expiree";

type LoadState = "loading" | "ready" | "unavailable";

export default function SubscriptionAccessPage() {
  const {
    user,
    isLoading,
    restrictedToken,
    completeRestrictedAccess,
    endRestrictedSession,
    logout,
  } = useAuth();
  const router = useRouter();
  const { t } = useT("subscription");
  const [context, setContext] = useState<ApiAuthContext | null>(null);
  const [organizationName, setOrganizationName] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [verifying, setVerifying] = useState(false);
  const [verifyMessage, setVerifyMessage] = useMessage("subscription");
  const [reloadKey, setReloadKey] = useState(0);
  const [retryTick, setRetryTick] = useState(0);
  const [online, setOnline] = useState(true);
  const leaving = useRef(false);

  const leaveExpired = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    endRestrictedSession();
    router.replace(EXPIRED_LOGIN_URL);
  }, [endRestrictedSession, router]);

  useEffect(() => {
    setOnline(typeof navigator === "undefined" || navigator.onLine);
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Pas de session limitée : session applicative → /app ; jeton expiré →
  // reconnexion avec message ; sinon connexion.
  useEffect(() => {
    if (isLoading || restrictedToken) return;
    if (user) router.replace("/app");
    else if (hasStoredRestrictedToken()) leaveExpired();
    else router.replace("/auth/login");
  }, [isLoading, restrictedToken, user, router, leaveExpired]);

  useEffect(() => {
    if (!restrictedToken) return;
    let cancelled = false;
    setLoadState("loading");
    void (async () => {
      try {
        const ctx = await fetchAuthContext(restrictedToken);
        if (cancelled) return;
        setContext(ctx);
        setLoadState("ready");
        // Identité VÉRIFIÉE par le serveur avec ce jeton : rend lisibles
        // (consultation) les seules ventes locales de cette identité.
        void writeIdentityPointer({
          userId: ctx.userId,
          organizationId: ctx.organizationId,
          token: restrictedToken,
        }).then(() => {
          if (!cancelled) setReloadKey((v) => v + 1);
        });
        const organizations = await fetchActiveOrganizations(restrictedToken);
        if (cancelled) return;
        setOrganizationName(
          organizations.find((o) => o.organizationId === ctx.organizationId)
            ?.name ?? null,
        );
      } catch (err) {
        if (cancelled) return;
        if (axios.isAxiosError(err) && err.response?.status === 401) {
          leaveExpired();
          return;
        }
        setLoadState("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [restrictedToken, leaveExpired, retryTick]);

  const verify = useCallback(async () => {
    const token = getRestrictedToken();
    if (!token) {
      leaveExpired();
      return;
    }
    setVerifying(true);
    setVerifyMessage(null);
    try {
      const fresh = await fetchAuthContext(token);
      setContext(fresh);
      setReloadKey((v) => v + 1);
      // Une période active ne transforme JAMAIS directement ce jeton :
      // seul l'échange serveur délivre un JWT applicatif.
      if (fresh.access?.subscriptionState !== "active") {
        setVerifyMessage((tr) => tr("verify.stillInactive"));
        return;
      }
      const outcome = await completeRestrictedAccess();
      switch (outcome) {
        case "installed":
          router.replace("/app");
          return;
        case "expired":
          leaveExpired();
          return;
        case "inactive":
          setVerifyMessage((tr) => tr("verify.stillInactive"));
          return;
        case "stale":
          setVerifyMessage((tr) => tr("verify.stale"));
          return;
        default:
          setVerifyMessage((tr) => tr("manager.checkUnavailable"));
      }
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        leaveExpired();
        return;
      }
      setVerifyMessage((tr) => tr("manager.checkUnavailable"));
    } finally {
      setVerifying(false);
    }
  }, [completeRestrictedAccess, leaveExpired, router, setVerifyMessage]);

  const handleLogout = useCallback(() => {
    void logout().then(() => router.replace("/auth/login"));
  }, [logout, router]);

  if (isLoading || !restrictedToken) return null;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-2xl items-center gap-3 px-4 sm:px-6">
          <span
            className="min-w-0 truncate font-semibold"
            title={fullNameOf(organizationName) ?? undefined}
          >
            {organizationName ?? t("access.yourShop")}
          </span>
          <span className="ml-auto hidden sm:block">
            <Wordmark size="small" />
          </span>
          {/* 1-16G : langue puis thème. */}
          <span className="ml-auto flex items-center gap-1 sm:ml-0">
            <LanguageSwitcher />
            <ThemeToggle className="inline-flex rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />
          </span>
        </div>
      </header>
      <main className="flex flex-1 flex-col">
        {loadState === "loading" && (
          <p
            role="status"
            className="mx-auto mt-10 text-sm text-muted-foreground"
          >
            {t("page.loading")}
          </p>
        )}
        {loadState === "unavailable" && (
          <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 px-4 text-center">
            <p role="alert" className="text-sm">
              {t("manager.checkUnavailable")}
            </p>
            <button
              type="button"
              className="h-11 rounded-md border px-4 text-sm font-medium hover:bg-muted"
              onClick={() => setRetryTick((v) => v + 1)}
            >
              {t("access.retry")}
            </button>
          </div>
        )}
        {loadState === "ready" && context && (
          <CommercialBlockScreen
            access={context.access ?? null}
            isOwner={context.access?.canRenew === true}
            restrictedToken={restrictedToken}
            offline={!online}
            identity={{
              userId: context.userId,
              organizationId: context.organizationId,
            }}
            pendingToken={restrictedToken}
            onVerify={() => void verify()}
            verifying={verifying}
            verifyMessage={verifyMessage}
            onLogout={handleLogout}
            managerReloadKey={reloadKey}
          />
        )}
      </main>
    </div>
  );
}
