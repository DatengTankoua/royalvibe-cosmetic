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
import { fmtXof } from "@/lib/currency";
import { createResponseOrder } from "@/lib/refresh-coordinator";
import { useLiveRefresh, useSocketSignals } from "@/hooks/use-live-refresh";
import { analyticsLabels } from "@/lib/analytics-labels";
import { UNKNOWN } from "./insights-sections";

// 1-16E — détails conservés de l'ancienne page Analyse (classements produits
// et vendeurs du mois, historique par mois, vue toutes périodes). Montés
// UNIQUEMENT quand la section est ouverte : aucune requête sinon. Champs
// financiers absents sans droit (le serveur ne les renvoie pas).

const L = analyticsLabels();
const number = new Intl.NumberFormat("fr-FR");
const UNKNOWN_COST_HINT = "Coût d'achat inconnu (produits supprimés)";
const TH = "py-2 px-2 text-right font-normal";

function monthLabel(period: string): string {
  const [year, month] = period.split("-");
  return new Date(Number(year), Number(month) - 1).toLocaleDateString("fr-FR", {
    month: "long",
    year: "numeric",
  });
}

function money(value: number | null | undefined): string {
  return value === null || value === undefined ? UNKNOWN : fmtXof(value);
}

export function AnalyticsDetails({
  month,
  signals,
}: {
  month: string;
  signals: readonly string[];
}) {
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
    return <p className="text-sm text-muted-foreground">{L.loading}</p>;
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
          {L.retry}
        </button>
      </div>
    );
  }
  const financials = products.some((p) => "netProfit" in p);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="font-medium">
          Tous les produits vendus · {monthLabel(month)}
        </h3>
        {products.length === 0 ? (
          <p className="text-sm text-muted-foreground">{L.sells.topEmpty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-2 text-left font-normal">
                    Produit
                  </th>
                  <th scope="col" className={TH}>
                    Vendus
                  </th>
                  <th scope="col" className={TH}>
                    Montant
                  </th>
                  {financials && (
                    <th scope="col" className={TH}>
                      Gain estimé
                    </th>
                  )}
                  <th scope="col" className="py-2 pl-2 text-right font-normal">
                    Stock actuel
                  </th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.productId} className="border-b last:border-0">
                    <td className="py-2 pr-2">
                      {p.productName ?? (
                        <span className="italic text-muted-foreground">
                          {L.sells.unnamed}
                        </span>
                      )}
                      {p.productDeleted && (
                        <Badge variant="secondary" className="ml-2">
                          {L.sells.deleted}
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
          Ventes par vendeur · {monthLabel(month)}
        </h3>
        {sellers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{L.sells.topEmpty}</p>
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
                    {number.format(s.transactionCount)} vente(s) ·{" "}
                    {number.format(s.totalUnitsSold)} unité(s)
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Historique par mois</h3>
        {monthly.length === 0 ? (
          <p className="text-sm text-muted-foreground">{L.sells.topEmpty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-2 text-left font-normal">
                    Mois
                  </th>
                  <th scope="col" className={TH}>
                    Montant
                  </th>
                  <th scope="col" className={TH}>
                    Ventes
                  </th>
                  <th scope="col" className="py-2 pl-2 text-right font-normal">
                    Unités
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
          <h3 className="font-medium">Depuis le début</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">
                Montant des ventes
              </dt>
              <dd className="tabular-nums">{fmtXof(overall.totalRevenue)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                Nombre de ventes
              </dt>
              <dd className="tabular-nums">
                {number.format(overall.totalTransactions)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Produits</dt>
              <dd className="tabular-nums">
                {number.format(overall.productsCount)}
              </dd>
            </div>
            {"totalInvested" in overall && (
              <div>
                <dt className="text-xs text-muted-foreground">
                  Capital investi
                </dt>
                <dd className="tabular-nums">{money(overall.totalInvested)}</dd>
              </div>
            )}
            {"netProfit" in overall && (
              <div>
                <dt className="text-xs text-muted-foreground">
                  Bénéfice estimé (toutes périodes)
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
