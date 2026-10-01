"use client";

import type { ApiSubscription, ApiSubscriptionPeriod } from "@/lib/api";
import { termLabel } from "@/lib/subscription-offers";

// 1-14C.2 — Lecture de l'abonnement du commerce (propriétaire réel).
// Toutes les valeurs viennent de la réponse serveur. Le temps restant est
// INFORMATIF (dates serveur + heure serveur de la dernière vérification) :
// il n'autorise jamais rien localement.

const DAY_MS = 24 * 60 * 60 * 1000;

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  })} à ${date.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export function subscriptionStatusLabel(subscription: {
  state: ApiSubscription["state"];
  currentPeriod?: ApiSubscriptionPeriod | null;
}): string {
  switch (subscription.state) {
    case "active":
      return subscription.currentPeriod?.kind === "trial"
        ? "Essai gratuit en cours"
        : "Abonnement actif";
    case "expired":
      return "Abonnement expiré";
    case "scheduled":
      return "Période à venir";
    default:
      return "Aucun abonnement";
  }
}

function periodLabel(period: ApiSubscriptionPeriod): string {
  return period.kind === "trial"
    ? "Essai gratuit"
    : `Abonnement ${termLabel(period.term)}`;
}

/** Temps restant arrondi au jour supérieur, à partir de l'heure SERVEUR. */
export function remainingLabel(
  coverageEndsAt: string | null,
  serverNow: string | null,
): string | null {
  if (!coverageEndsAt || !serverNow) return null;
  const ms = new Date(coverageEndsAt).getTime() - new Date(serverNow).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const days = Math.ceil(ms / DAY_MS);
  return days <= 1 ? "moins d'un jour" : `${days} jours`;
}

export function SubscriptionOverview({
  subscription,
  serverNow,
}: {
  subscription: ApiSubscription;
  /** Heure serveur de la dernière vérification (`access.checkedAt`). */
  serverNow: string | null;
}) {
  const remaining =
    subscription.state === "active"
      ? remainingLabel(subscription.coverageEndsAt, serverNow)
      : null;
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border p-3">
          <dt className="text-xs text-muted-foreground">État</dt>
          <dd className="mt-1 font-semibold" data-testid="subscription-status">
            {subscriptionStatusLabel(subscription)}
          </dd>
        </div>
        {subscription.currentPeriod && (
          <div className="rounded-lg border p-3">
            <dt className="text-xs text-muted-foreground">Période en cours</dt>
            <dd className="mt-1 text-sm">
              <span className="font-medium">
                {periodLabel(subscription.currentPeriod)}
              </span>
              <span className="block text-muted-foreground">
                du {formatDateTime(subscription.currentPeriod.startsAt)} au{" "}
                {formatDateTime(subscription.currentPeriod.endsAt)}
              </span>
            </dd>
          </div>
        )}
        {subscription.coverageEndsAt && (
          <div className="rounded-lg border p-3">
            <dt className="text-xs text-muted-foreground">
              {subscription.state === "expired"
                ? "Accès terminé le"
                : "Accès couvert jusqu'au"}
            </dt>
            <dd className="mt-1 text-sm" data-testid="subscription-coverage">
              {formatDateTime(subscription.coverageEndsAt)}
              {remaining && (
                <span className="block text-muted-foreground">
                  Temps restant : {remaining}
                </span>
              )}
            </dd>
          </div>
        )}
        {subscription.nextPeriodStartsAt && (
          <div className="rounded-lg border p-3">
            <dt className="text-xs text-muted-foreground">Prochaine période</dt>
            <dd className="mt-1 text-sm">
              à partir du {formatDateTime(subscription.nextPeriodStartsAt)}
            </dd>
          </div>
        )}
      </dl>

      <section
        aria-labelledby="subscription-history-title"
        className="space-y-2"
      >
        <h3 id="subscription-history-title" className="text-sm font-semibold">
          Historique des périodes
        </h3>
        {subscription.periods.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune période.</p>
        ) : (
          <ul
            className="divide-y rounded-lg border"
            data-testid="subscription-history"
          >
            {subscription.periods.map((period) => (
              <li
                key={`${period.startsAt}-${period.endsAt}-${period.kind}`}
                className="flex flex-col gap-0.5 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="font-medium">{periodLabel(period)}</span>
                <span className="text-muted-foreground">
                  {formatDateTime(period.startsAt)} →{" "}
                  {formatDateTime(period.endsAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Historique des périodes d&apos;accès, sans montant : les paiements
          figurent dans l&apos;historique des paiements ; les factures seront
          disponibles ultérieurement.
        </p>
      </section>
    </div>
  );
}
