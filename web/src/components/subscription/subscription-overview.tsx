"use client";

import type { TFunction } from "i18next";
import { useT } from "next-i18next/client";
import type { ApiSubscription, ApiSubscriptionPeriod } from "@/lib/api";
import { knownTerm } from "@/lib/subscription-offers";
import { dateFormat } from "@/i18n/format";
import { useLocale } from "@/i18n/locale-provider";
import type { Locale } from "@/i18n/settings";

// 1-14C.2 — Lecture de l'abonnement du commerce (propriétaire réel).
// Toutes les valeurs viennent de la réponse serveur. Le temps restant est
// INFORMATIF (dates serveur + heure serveur de la dernière vérification) :
// il n'autorise jamais rien localement.

const DAY_MS = 24 * 60 * 60 * 1000;

type SubscriptionT = TFunction<"subscription">;

export function formatDateTime(
  iso: string,
  locale: Locale,
  t: SubscriptionT,
): string {
  const date = new Date(iso);
  return t("overview.dateAt", {
    date: dateFormat(locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(date),
    time: dateFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(
      date,
    ),
  });
}

export function subscriptionStatusLabel(
  subscription: {
    state: ApiSubscription["state"];
    currentPeriod?: ApiSubscriptionPeriod | null;
  },
  t: SubscriptionT,
): string {
  switch (subscription.state) {
    case "active":
      return subscription.currentPeriod?.kind === "trial"
        ? t("overview.state.trial")
        : t("overview.state.active");
    case "expired":
      return t("overview.state.expired");
    case "scheduled":
      return t("overview.state.scheduled");
    default:
      return t("overview.state.none");
  }
}

function periodLabel(period: ApiSubscriptionPeriod, t: SubscriptionT): string {
  if (period.kind === "trial") return t("overview.trial");
  const term = knownTerm(period.term);
  return t("overview.subscriptionTerm", {
    term: term ? t(`offers.term.${term}`) : "—",
  });
}

/** Temps restant arrondi au jour supérieur, à partir de l'heure SERVEUR. */
export function remainingLabel(
  coverageEndsAt: string | null,
  serverNow: string | null,
  t: SubscriptionT,
): string | null {
  if (!coverageEndsAt || !serverNow) return null;
  const ms = new Date(coverageEndsAt).getTime() - new Date(serverNow).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const days = Math.ceil(ms / DAY_MS);
  return days <= 1
    ? t("overview.lessThanDay")
    : t("overview.days", { count: days });
}

export function SubscriptionOverview({
  subscription,
  serverNow,
}: {
  subscription: ApiSubscription;
  /** Heure serveur de la dernière vérification (`access.checkedAt`). */
  serverNow: string | null;
}) {
  const { t } = useT("subscription");
  const { locale } = useLocale();
  const at = (iso: string) => formatDateTime(iso, locale, t);
  const remaining =
    subscription.state === "active"
      ? remainingLabel(subscription.coverageEndsAt, serverNow, t)
      : null;
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border p-3">
          <dt className="text-xs text-muted-foreground">
            {t("overview.status")}
          </dt>
          <dd className="mt-1 font-semibold" data-testid="subscription-status">
            {subscriptionStatusLabel(subscription, t)}
          </dd>
        </div>
        {subscription.currentPeriod && (
          <div className="rounded-lg border p-3">
            <dt className="text-xs text-muted-foreground">
              {t("overview.currentPeriod")}
            </dt>
            <dd className="mt-1 text-sm">
              <span className="font-medium">
                {periodLabel(subscription.currentPeriod, t)}
              </span>
              <span className="block text-muted-foreground">
                {t("overview.fromTo", {
                  from: at(subscription.currentPeriod.startsAt),
                  to: at(subscription.currentPeriod.endsAt),
                })}
              </span>
            </dd>
          </div>
        )}
        {subscription.coverageEndsAt && (
          <div className="rounded-lg border p-3">
            <dt className="text-xs text-muted-foreground">
              {subscription.state === "expired"
                ? t("overview.accessEnded")
                : t("overview.accessUntil")}
            </dt>
            <dd className="mt-1 text-sm" data-testid="subscription-coverage">
              {at(subscription.coverageEndsAt)}
              {remaining && (
                <span className="block text-muted-foreground">
                  {t("overview.remaining", { remaining })}
                </span>
              )}
            </dd>
          </div>
        )}
        {subscription.nextPeriodStartsAt && (
          <div className="rounded-lg border p-3">
            <dt className="text-xs text-muted-foreground">
              {t("overview.nextPeriod")}
            </dt>
            <dd className="mt-1 text-sm">
              {t("overview.startingOn", {
                date: at(subscription.nextPeriodStartsAt),
              })}
            </dd>
          </div>
        )}
      </dl>

      <section
        aria-labelledby="subscription-history-title"
        className="space-y-2"
      >
        <h3 id="subscription-history-title" className="text-sm font-semibold">
          {t("overview.historyTitle")}
        </h3>
        {subscription.periods.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("overview.historyEmpty")}
          </p>
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
                <span className="font-medium">{periodLabel(period, t)}</span>
                <span className="text-muted-foreground">
                  {at(period.startsAt)} → {at(period.endsAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          {t("overview.historyNote")}
        </p>
      </section>
    </div>
  );
}
