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
import {
  SUBSCRIPTION_OFFERS,
  formatFcfa,
  type SubscriptionTerm,
} from "@/lib/subscription-offers";
import { SubscriptionOverview } from "./subscription-overview";
import { OfferConditions, OfferSelector } from "./subscription-offers";

// 1-14C.2 — Gestion de l'abonnement par le PROPRIÉTAIRE réel (droit issu du
// serveur : rôle de la membership / `access.canRenew`, jamais `User.role`).
// `token` : jeton limité explicite (session limitée) ; absent = JWT
// applicatif courant. Le renouvellement n'est qu'une SÉLECTION : le paiement
// arrive en 1-14D — aucun bouton de paiement, aucune activation locale.

export function SubscriptionManager({
  token,
  serverNow,
  reloadKey,
  onVerify,
  verifying,
  verifyMessage,
}: {
  token?: string;
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
  const [renewing, setRenewing] = useState(false);
  const [selected, setSelected] = useState<SubscriptionTerm | null>(null);

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

  const choice = SUBSCRIPTION_OFFERS.find((offer) => offer.term === selected);

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
          className="h-11 px-5"
          aria-expanded={renewing}
          aria-controls="subscription-renewal"
          onClick={() => setRenewing((v) => !v)}
        >
          Renouveler
        </Button>
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

      {renewing && (
        <section
          id="subscription-renewal"
          aria-labelledby="subscription-renewal-title"
          className="space-y-4 rounded-xl border p-4"
        >
          <h3 id="subscription-renewal-title" className="font-semibold">
            Choisir une durée
          </h3>
          <OfferSelector selected={selected} onSelect={setSelected} />
          <OfferConditions />
          <div
            role="status"
            aria-live="polite"
            className="rounded-lg bg-muted p-3 text-sm"
          >
            {choice ? (
              <p>
                Durée choisie : <strong>{choice.label}</strong>, montant total{" "}
                <strong>{formatFcfa(choice.totalXaf)}</strong>.
              </p>
            ) : (
              <p>Sélectionnez une durée pour voir le montant total.</p>
            )}
            <p className="mt-1 text-muted-foreground">
              Le paiement en ligne sera bientôt disponible. Une fois votre
              abonnement activé, utilisez « Vérifier mon abonnement » pour
              retrouver l&apos;accès.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
