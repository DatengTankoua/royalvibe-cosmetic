"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  fetchMonthlyTrend,
  fetchOverview,
  fetchProductsRanking,
  fetchSellersRanking,
  getApiErrorMessage,
  type AnalyticsOverview,
  type MonthlyTrend,
  type ProductRanking,
  type SellerRanking,
} from "@/lib/api";
import { createResponseOrder } from "@/lib/refresh-coordinator";
import { useLiveRefresh, useSocketSignals } from "@/hooks/use-live-refresh";
import { UNKNOWN } from "./insights-sections";
import { useAnalytics } from "./use-analytics";

// 1-16E — détails conservés de l'ancienne page Analyse (classements produits
// et vendeurs du mois, historique par mois, vue toutes périodes). Montés
// UNIQUEMENT quand la section est ouverte : aucune requête sinon. Champs
// financiers absents sans droit (le serveur ne les renvoie pas).

const TH = "py-2 px-2 text-right font-normal";

export function AnalyticsDetails({
  month,
  signals,
}: {
  month: string;
  signals: readonly string[];
}) {
  // 1-16G : textes `analytics` (`details.*`), formats selon la langue.
  const a = useAnalytics();
  const { t, monthLabel } = a;
  const number = { format: a.number };
  const fmtXof = a.fcfa;
  const money = (value: number | null | undefined) =>
    value === null || value === undefined ? UNKNOWN : a.fcfa(value);
  const UNKNOWN_COST_HINT = t("details.unknownCost");
  const [products, setProducts] = useState<ProductRanking[]>([]);
  const [sellers, setSellers] = useState<SellerRanking[]>([]);
  const [monthly, setMonthly] = useState<MonthlyTrend[]>([]);
  const [overall, setOverall] = useState<AnalyticsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
        const [pr, sr, mt, ov] = await Promise.all([
          fetchProductsRanking(month),
          fetchSellersRanking(month),
          fetchMonthlyTrend(),
          fetchOverview(),
        ]);
        if (!order.current.accept(ticket)) return;
        setProducts(pr);
        setSellers(sr);
        setMonthly(mt);
        setOverall(ov);
        setError(null);
        setLoadedAt(requestedAt);
      } catch (err) {
        if (!options.silent) setError(getApiErrorMessage(err));
      } finally {
        if (!options.silent) setLoading(false);
      }
    },
    [month],
  );

  useEffect(() => {
    void load();
  }, [load]);
  const scheduleRefresh = useLiveRefresh(
    () => load({ silent: true }),
    loadedAt,
  );
  useSocketSignals(signals, scheduleRefresh);

  if (loading) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
  }
  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="text-sm text-(--tenant-accent-ink) underline underline-offset-2 hover:no-underline"
        >
          {t("retry")}
        </button>
      </div>
    );
  }
  const financials = products.some((p) => "netProfit" in p);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="font-medium">
          {t("details.allProducts", { month: monthLabel(month) })}
        </h3>
        {products.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("sells.topEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-2 text-left font-normal">
                    {t("details.product")}
                  </th>
                  <th scope="col" className={TH}>
                    {t("details.sold")}
                  </th>
                  <th scope="col" className={TH}>
                    {t("details.amount")}
                  </th>
                  {financials && (
                    <th scope="col" className={TH}>
                      {t("details.estimatedGain")}
                    </th>
                  )}
                  <th scope="col" className="py-2 pl-2 text-right font-normal">
                    {t("details.currentStock")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.productId} className="border-b last:border-0">
                    <td className="py-2 pr-2">
                      {p.productName ?? (
                        <span className="italic text-muted-foreground">
                          {t("sells.unnamed")}
                        </span>
                      )}
                      {p.productDeleted && (
                        <Badge variant="secondary" className="ml-2">
                          {t("sells.deleted")}
                        </Badge>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {number.format(p.totalUnitsSold)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {fmtXof(p.totalRevenue)}
                    </td>
                    {financials && (
                      <td
                        className="px-2 py-2 text-right tabular-nums"
                        title={
                          p.netProfit === null ? UNKNOWN_COST_HINT : undefined
                        }
                      >
                        {money(p.netProfit)}
                      </td>
                    )}
                    <td className="py-2 pl-2 text-right tabular-nums">
                      {p.remainingQuantity ?? UNKNOWN}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">
          {t("details.sellersTitle", { month: monthLabel(month) })}
        </h3>
        {sellers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("sells.topEmpty")}</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {sellers.map((s) => (
              <li
                key={s.sellerId}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{s.sellerName}</p>
                  <p className="text-xs text-muted-foreground break-all">
                    {s.sellerEmail}
                  </p>
                </div>
                <div className="text-right text-sm">
                  <p className="font-medium tabular-nums">
                    {fmtXof(s.totalRevenue)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("details.sellerSales", {
                      count: s.transactionCount,
                      n: number.format(s.transactionCount),
                    })}{" "}
                    ·{" "}
                    {t("details.sellerUnits", {
                      count: s.totalUnitsSold,
                      n: number.format(s.totalUnitsSold),
                    })}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">{t("details.historyTitle")}</h3>
        {monthly.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("sells.topEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-2 text-left font-normal">
                    {t("details.month")}
                  </th>
                  <th scope="col" className={TH}>
                    {t("details.amount")}
                  </th>
                  <th scope="col" className={TH}>
                    {t("details.sales")}
                  </th>
                  <th scope="col" className="py-2 pl-2 text-right font-normal">
                    {t("details.units")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...monthly].reverse().map((m) => (
                  <tr key={m.period} className="border-b last:border-0">
                    <td className="py-2 pr-2">{monthLabel(m.period)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {fmtXof(m.totalRevenue)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {number.format(m.transactionCount)}
                    </td>
                    <td className="py-2 pl-2 text-right tabular-nums">
                      {number.format(m.totalUnitsSold)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {overall && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">{t("details.sinceStart")}</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("details.salesAmount")}
              </dt>
              <dd className="tabular-nums">{fmtXof(overall.totalRevenue)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("details.salesCount")}
              </dt>
              <dd className="tabular-nums">
                {number.format(overall.totalTransactions)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("details.products")}
              </dt>
              <dd className="tabular-nums">
                {number.format(overall.productsCount)}
              </dd>
            </div>
            {"totalInvested" in overall && (
              <div>
                <dt className="text-xs text-muted-foreground">
                  {t("details.capital")}
                </dt>
                <dd className="tabular-nums">{money(overall.totalInvested)}</dd>
              </div>
            )}
            {"netProfit" in overall && (
              <div>
                <dt className="text-xs text-muted-foreground">
                  {t("details.profitAll")}
                </dt>
                <dd
                  className="tabular-nums"
                  title={
                    overall.netProfit === null ? UNKNOWN_COST_HINT : undefined
                  }
                >
                  {money(overall.netProfit)}
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}
    </div>
  );
}
