"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { useT } from "next-i18next/client";
import { Button } from "@/components/ui/button";
import {
  fetchSubscription,
  getApiErrorCode,
  isNetworkError,
  SUBSCRIPTION_STATUS_UNAVAILABLE,
  type ApiSubscription,
} from "@/lib/api";
import type { PaymentIdentity } from "@/lib/payment-intent";
import { createResponseOrder } from "@/lib/refresh-coordinator";
import { useLiveRefresh, useSocketSignals } from "@/hooks/use-live-refresh";
import { SubscriptionOverview } from "./subscription-overview";
import { SubscriptionPaymentPanel } from "./subscription-payment-panel";

// 1-14C.2 — Gestion de l'abonnement par le PROPRIÉTAIRE réel (droit issu du
// serveur : rôle de la membership / `access.canRenew`, jamais `User.role`).
// `token` : jeton limité explicite (session limitée) ; absent = JWT
// applicatif courant.
// 1-14D.2C — Renouvellement par paiement Mobile Money
// (`SubscriptionPaymentPanel`) ; aucune activation locale : l'abonnement
// n'est actif qu'après confirmation serveur, puis reprise via `onVerify`.
//
// 1-15F — session applicative (socket du shell) : `subscription:changed`
// (payload vide) → relecture SILENCIEUSE regroupée de
// `GET /organizations/current/subscription` (lecture locale en base, jamais
// le prestataire), rattrapée à la reconnexion. Réponse ignorée si elle
// appartient à une autre session / organisation ou si une réponse plus
// récente a déjà été appliquée. Aucun échange de session, aucune relecture
// du contexte : la reprise reste l'action explicite `onVerify`. Session
// limitée ou écran de blocage : aucun socket, donc aucun signal.

const SUBSCRIPTION_SIGNALS = ["subscription:changed"] as const;
const NO_SIGNALS: readonly string[] = [];

export function SubscriptionManager({
  token,
  identity,
  serverNow,
  reloadKey,
  onVerify,
  verifying,
  verifyMessage,
}: {
  token?: string;
  /** Identité VÉRIFIÉE par le serveur ; `null` : paiement indisponible. */
  identity: PaymentIdentity | null;
  serverNow: string | null;
  /** Incrémenté après une vérification pour relire l'abonnement. */
  reloadKey: number;
  onVerify: () => void;
  verifying: boolean;
  verifyMessage: string | null;
}) {
  const [subscription, setSubscription] = useState<ApiSubscription | null>(
    null,
  );
  const { t } = useT("subscription");
  const [loadError, setLoadError] = useState<
    "checkUnavailable" | "infoUnavailable" | null
  >(null);
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);
  // Portée des réponses : identité serveur + nature du jeton.
  const scope = `${identity?.userId ?? "-"}:${identity?.organizationId ?? "-"}:${token ? "limited" : "app"}`;
  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);
  const order = useRef(createResponseOrder());

  const load = useCallback(
    async (silent: boolean) => {
      const requestScope = scope;
      const requestedAt = Date.now();
      const ticket = order.current.begin();
      if (!silent) setLoadError(null);
      try {
        const data = await fetchSubscription(token);
        if (scopeRef.current !== requestScope) return;
        if (!order.current.accept(ticket)) return;
        setSubscription(data);
        setLoadError(null);
        setLoadedAt(requestedAt);
      } catch (err: unknown) {
        // Relecture silencieuse en échec : l'affichage est conservé.
        if (silent || scopeRef.current !== requestScope) return;
        setLoadError(
          isNetworkError(err) ||
            getApiErrorCode(err) === SUBSCRIPTION_STATUS_UNAVAILABLE
            ? "checkUnavailable"
            : "infoUnavailable",
        );
      }
    },
    [scope, token],
  );

  useEffect(() => {
    void load(false);
  }, [load, reloadKey]);

  const live = token === undefined && identity !== null;
  const requestReload = useLiveRefresh(
    () => load(true),
    live ? loadedAt : undefined,
  );
  useSocketSignals(live ? SUBSCRIPTION_SIGNALS : NO_SIGNALS, requestReload);

  return (
    <div className="space-y-6">
      {loadError && (
        <p role="alert" className="text-sm text-destructive">
          {t(`manager.${loadError}`)}
        </p>
      )}
      {!subscription && !loadError && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("manager.loading")}
        </p>
      )}
      {subscription && (
        <SubscriptionOverview
          subscription={subscription}
          serverNow={serverNow}
        />
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          type="button"
          variant="outline"
          className="h-11 px-5"
          disabled={verifying}
          onClick={onVerify}
        >
          <RefreshCwIcon
            className={`h-4 w-4 ${verifying ? "animate-spin" : ""}`}
            aria-hidden
          />
          {verifying ? t("payment.checking") : t("manager.verify")}
        </Button>
      </div>
      {verifyMessage && (
        <p role="status" aria-live="polite" className="text-sm">
          {verifyMessage}
        </p>
      )}

      <section
        aria-labelledby="subscription-renewal-title"
        className="space-y-4"
        id="subscription-renewal"
      >
        <h3 id="subscription-renewal-title" className="text-base font-semibold">
          {t("manager.renewal")}
        </h3>
        {identity ? (
          // Remonté à chaque changement d'identité ou de session : aucune
          // donnée d'un contexte précédent n'est conservée.
          <SubscriptionPaymentPanel
            key={`${identity.userId}:${identity.organizationId}:${token ? "limited" : "app"}`}
            identity={identity}
            token={token}
            onAccessRestore={onVerify}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("manager.paymentUnavailable")}
          </p>
        )}
      </section>
    </div>
  );
}
