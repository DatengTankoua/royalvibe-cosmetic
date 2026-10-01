"use client";

import { useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  fetchSubscription,
  getApiErrorCode,
  isNetworkError,
  SUBSCRIPTION_STATUS_UNAVAILABLE,
  type ApiSubscription,
} from "@/lib/api";
import type { PaymentIdentity } from "@/lib/payment-intent";
import { SubscriptionOverview } from "./subscription-overview";
import { SubscriptionPaymentPanel } from "./subscription-payment-panel";

// 1-14C.2 — Gestion de l'abonnement par le PROPRIÉTAIRE réel (droit issu du
// serveur : rôle de la membership / `access.canRenew`, jamais `User.role`).
// `token` : jeton limité explicite (session limitée) ; absent = JWT
// applicatif courant.
// 1-14D.2C — Renouvellement par paiement Mobile Money
// (`SubscriptionPaymentPanel`) ; aucune activation locale : l'abonnement
// n'est actif qu'après confirmation serveur, puis reprise via `onVerify`.

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
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    fetchSubscription(token)
      .then((data) => {
        if (!cancelled) setSubscription(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          isNetworkError(err) ||
            getApiErrorCode(err) === SUBSCRIPTION_STATUS_UNAVAILABLE
            ? "Vérification momentanément indisponible."
            : "Informations d'abonnement indisponibles.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [token, reloadKey]);

  return (
    <div className="space-y-6">
      {loadError && (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      )}
      {!subscription && !loadError && (
        <p role="status" className="text-sm text-muted-foreground">
          Chargement de l&apos;abonnement…
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
          {verifying ? "Vérification…" : "Vérifier mon abonnement"}
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
          Renouvellement
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
            Paiement momentanément indisponible. Utilisez « Vérifier mon
            abonnement ».
          </p>
        )}
      </section>
    </div>
  );
}
