"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  fetchInsights,
  fetchMonthlyTrend,
  getApiErrorMessage,
  type AnalyticsInsights,
  type InsightPriorityKind,
} from "@/lib/api";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { useOfflineSales } from "@/contexts/offline-sales-context";
import { hasPermission } from "@/lib/organization-permissions";
import { useLiveRefresh, useSocketSignals } from "@/hooks/use-live-refresh";
import { SALE_INVALIDATION_EVENTS } from "@/hooks/use-sale-invalidation";
import { createResponseOrder } from "@/lib/refresh-coordinator";
import { MonthlyHistoryDownload } from "@/components/analytics/monthly-history-download";
import { canDownloadMonthlyHistory } from "@/lib/monthly-history";
import { useAnalytics } from "@/components/analytics/use-analytics";
import {
  FOCUS,
  SalesSection,
  SellsSection,
  StockDetails,
  WatchSection,
} from "@/components/analytics/insights-sections";
import { AnalyticsDetails } from "@/components/analytics/analytics-details";

// 1-15A : toute vente (création, modification, suppression) et tout
// changement de produit modifient les indicateurs — relecture silencieuse.
const ANALYTICS_SIGNALS = [
  ...SALE_INVALIDATION_EVENTS,
  "product:created",
  "product:updated",
  "product:deleted",
  // 1-15B : suppression définitive (capital investi, épuisés…).
  "product:purged",
] as const;

const DETAILS_SUMMARY = `${FOCUS} flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-2xl px-4 py-3 font-semibold`;

// /app/analytics (1-9D) — 1-16E : page orientée décisions, dans l'ordre
// « À surveiller », « Vos ventes », « Ce qui se vend » ; détails repliés.
// `analytics.read` gate TOUTES les routes : aucun appel sans cette permission.
// Les droits financiers sont revalidés par le serveur (champs absents).
export default function AnalyticsPage() {
  // 1-16G : textes `analytics`, mois et heures selon la langue.
  const a = useAnalytics();
  const { t } = a;
  const { authContext } = useOrganizationShell();
  const canRead = hasPermission(authContext, "analytics.read");
  const canAdjustStock = hasPermission(authContext, "stock.adjust");
  const { unfinalizedCount } = useOfflineSales();
  const selectId = useId();

  // "" : mois en cours DU SERVEUR (fuseau de l'API, pas du navigateur).
  const [month, setMonth] = useState<string>("");
  const [serverCurrentMonth, setServerCurrentMonth] = useState<string | null>(
    null,
  );
  const [months, setMonths] = useState<string[]>([]);
  const [insights, setInsights] = useState<AnalyticsInsights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryKey, setRetryKey] = useState(0);
  const [stockOpen, setStockOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // 1-15A : début de la dernière lecture réussie (rattrapage après
  // reconnexion) ; une réponse périmée n'écrase jamais une plus récente.
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);
  const order = useRef(createResponseOrder());

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) {
        setLoading(true);
        setError(null);
      }
      const requestedAt = Date.now();
      const ticket = order.current.begin();
      try {
        const [data, trend] = await Promise.all([
          fetchInsights(month || undefined),
          fetchMonthlyTrend(),
        ]);
        if (!order.current.accept(ticket)) return;
        setInsights(data);
        if (data.period.isCurrentMonth)
          setServerCurrentMonth(data.period.month);
        setMonths(trend.map((m) => m.period));
        setError(null);
        setLoadedAt(requestedAt);
      } catch (err) {
        // Une relecture silencieuse en échec conserve les chiffres affichés.
        if (!options.silent) setError(getApiErrorMessage(err));
      } finally {
        if (!options.silent) setLoading(false);
      }
    },
    [month],
  );

  useEffect(() => {
    if (!authContext) return;
    if (!canRead) {
      setLoading(false);
      return;
    }
    void load();
  }, [authContext, canRead, retryKey, load]);

  const scheduleRefresh = useLiveRefresh(
    () => (canRead ? load({ silent: true }) : Promise.resolve()),
    canRead ? loadedAt : undefined,
  );
  useSocketSignals(ANALYTICS_SIGNALS, scheduleRefresh);

  const seeAll = useCallback((kind: InsightPriorityKind) => {
    setStockOpen(true);
    // Après l'ouverture : défilement et focus sur la liste concernée.
    requestAnimationFrame(() => {
      const target = document.getElementById(`stock-${kind}`);
      if (!target) return;
      target.scrollIntoView({ block: "start" });
      target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    });
  }, []);

  if (authContext && !canRead) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-10 sm:px-6">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("noPermission")}</p>
      </div>
    );
  }

  const current = serverCurrentMonth;
  const selected = month || insights?.period.month || "";
  const options = Array.from(
    new Set([current, ...months, selected].filter((m): m is string => !!m)),
  )
    .filter((m) => !current || m <= current)
    .sort()
    .reverse();
  const generatedTime = insights ? a.formatTime(insights.generatedAt) : null;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={selectId} className="text-xs text-muted-foreground">
            {t("periodLabel")}
          </label>
          <select
            id={selectId}
            value={selected}
            disabled={options.length === 0}
            onChange={(e) => setMonth(e.target.value)}
            className={`${FOCUS} min-h-10 rounded-lg border bg-background px-3 text-sm`}
          >
            {options.map((m) => (
              <option key={m} value={m}>
                {m === current
                  ? t("currentMonthOption", { label: a.monthLabel(m) })
                  : a.monthLabel(m)}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div
        aria-live="polite"
        className="flex flex-col gap-1 text-xs text-muted-foreground"
      >
        {generatedTime && <p>{t("freshness", { time: generatedTime })}</p>}
        <p>
          {unfinalizedCount > 0
            ? `${t("unsyncedPending", {
                count: unfinalizedCount,
                n: a.number(unfinalizedCount),
              })} ${t("unsyncedNote")}`
            : t("unsyncedNote")}
        </p>
      </div>

      {loading && !insights && (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      )}
      {!loading && error && (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-destructive">{error}</p>
          <button
            type="button"
            onClick={() => setRetryKey((k) => k + 1)}
            className={`${FOCUS} rounded text-sm text-(--tenant-accent-ink) underline underline-offset-2 hover:no-underline`}
          >
            {t("retry")}
          </button>
        </div>
      )}

      {insights && (
        <div
          className={`flex flex-col gap-8 ${loading ? "opacity-60" : ""}`}
          aria-busy={loading}
        >
          <WatchSection
            insights={insights}
            rights={{ canAdjustStock }}
            onSeeAll={seeAll}
          />
          <SalesSection insights={insights} />
          <SellsSection insights={insights} />
          {/* 1-16D : historique mensuel exportable (propriétaire, administrateur). */}
          {canDownloadMonthlyHistory(authContext) && <MonthlyHistoryDownload />}

          <details
            id="stock-details"
            open={stockOpen}
            onToggle={(e) => setStockOpen(e.currentTarget.open)}
            className="rounded-2xl border bg-card"
          >
            <summary className={DETAILS_SUMMARY}>{t("stock.title")}</summary>
            <div className="px-4 pb-4">
              <StockDetails insights={insights} rights={{ canAdjustStock }} />
            </div>
          </details>

          <details
            id="analytics-details"
            open={detailsOpen}
            onToggle={(e) => setDetailsOpen(e.currentTarget.open)}
            className="rounded-2xl border bg-card"
          >
            <summary className={DETAILS_SUMMARY}>
              {t("details.summary", {
                title: t("details.title"),
                open: t("details.open"),
              })}
            </summary>
            <div className="px-4 pb-4">
              {detailsOpen && (
                <AnalyticsDetails
                  month={insights.period.month}
                  signals={ANALYTICS_SIGNALS}
                />
              )}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
