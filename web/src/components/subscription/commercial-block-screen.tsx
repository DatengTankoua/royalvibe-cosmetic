"use client";

import { LogOutIcon, RefreshCwIcon } from "lucide-react";
import type { TFunction } from "i18next";
import { useT } from "next-i18next/client";
import { Button } from "@/components/ui/button";
import type { ApiAccessView } from "@/lib/api";
import { SubscriptionManager } from "./subscription-manager";
import { LocalPendingSales } from "./local-pending-sales";

// 1-14C.2 — Écran unique de blocage commercial (session applicative
// bloquée, session limitée, ou blocage connu hors ligne). Un seul message
// principal par situation, aucun terme technique. Aucun appel métier : seuls
// la lecture d'abonnement (propriétaire) et la consultation locale.

export function blockTitle(
  access: ApiAccessView | null,
  t: TFunction<"subscription">,
): string {
  switch (access?.subscriptionState) {
    case "expired":
      return t("block.title.expired");
    case "none":
      return t("block.title.none");
    case "scheduled":
      return t("block.title.scheduled");
    case "active":
      // Abonnement actif mais accès pas encore rétabli (session limitée).
      return t("block.title.active");
    default:
      return t("block.title.inactive");
  }
}

export function CommercialBlockScreen({
  access,
  isOwner,
  restrictedToken,
  offline,
  identity,
  pendingToken,
  onVerify,
  verifying,
  verifyMessage,
  onLogout,
  managerReloadKey,
}: {
  access: ApiAccessView | null;
  /** Propriétaire RÉEL (serveur), jamais un rôle legacy ou délégué. */
  isOwner: boolean;
  /** Jeton limité explicite ; absent = JWT applicatif courant. */
  restrictedToken?: string;
  offline: boolean;
  identity: { userId: string; organizationId: string } | null;
  /** Jeton servant à vérifier l'identité locale des ventes en attente. */
  pendingToken: string | null;
  onVerify: () => void;
  verifying: boolean;
  verifyMessage: string | null;
  onLogout: () => void;
  managerReloadKey: number;
}) {
  const { t } = useT("subscription");
  const activeButLimited = access?.subscriptionState === "active";
  return (
    <div
      className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6"
      data-testid="commercial-block-screen"
    >
      <div className="space-y-2">
        <h1
          className="text-xl font-bold"
          tabIndex={-1}
          id="commercial-block-title"
        >
          {blockTitle(access, t)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {offline
            ? t("block.text.offline")
            : activeButLimited
              ? t("block.text.activeLimited")
              : isOwner
                ? t("block.text.owner")
                : t("block.text.member")}
        </p>
      </div>

      {isOwner && !offline ? (
        <SubscriptionManager
          token={restrictedToken}
          identity={identity}
          serverNow={access?.checkedAt ?? null}
          reloadKey={managerReloadKey}
          onVerify={onVerify}
          verifying={verifying}
          verifyMessage={verifyMessage}
        />
      ) : (
        <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            className="h-11 px-5"
            disabled={verifying || offline}
            onClick={onVerify}
          >
            <RefreshCwIcon
              className={`h-4 w-4 ${verifying ? "animate-spin" : ""}`}
              aria-hidden
            />
            {verifying ? t("payment.checking") : t("block.verifyAccess")}
          </Button>
          {verifyMessage && (
            <p role="status" aria-live="polite" className="text-sm">
              {verifyMessage}
            </p>
          )}
        </div>
      )}

      <LocalPendingSales identity={identity} token={pendingToken} />

      <div>
        <Button
          type="button"
          variant="ghost"
          className="h-11 px-4 text-muted-foreground"
          onClick={onLogout}
        >
          <LogOutIcon className="h-4 w-4" aria-hidden />
          {t("block.logout")}
        </Button>
      </div>
    </div>
  );
}
