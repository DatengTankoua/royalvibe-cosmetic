"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  fetchOverview,
  fetchProducts,
  fetchProductsRanking,
  fetchSellersRanking,
  fetchMonthlyTrend,
  getApiErrorMessage,
  type AnalyticsOverview,
  type ApiProduct,
  type ProductRanking,
  type SellerRanking,
  type MonthlyTrend,
} from "@/lib/api";
import { useAuth } from "@/contexts/auth-context";
import { fmtXof } from "@/lib/currency";

const fmt = fmtXof;
const pct = (n: number) => `${n.toFixed(1)}%`;

// "2025-03" → "mars 2025"
function formatMonthLabel(period: string): string {
  const [year, month] = period.split("-");
  return new Date(Number(year), Number(month) - 1).toLocaleDateString("fr-FR", {
    month: "long",
    year: "numeric",
  });
}

function StatCard({
  label,
  value,
  sub,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </>
  );
  return (
    <Card
      className={
        onClick ? "cursor-pointer hover:border-primary transition-colors" : ""
      }
      onClick={onClick}
    >
      <CardContent className="pt-5 pb-4">{inner}</CardContent>
    </Card>
  );
}

export default function AnalyticsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();

  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [products, setProducts] = useState<ProductRanking[]>([]);
  const [sellers, setSellers] = useState<SellerRanking[]>([]);
  const [monthly, setMonthly] = useState<MonthlyTrend[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedMonth, setSelectedMonth] = useState<string>(""); // "" = toutes périodes
  const [outOfStockProducts, setOutOfStockProducts] = useState<ApiProduct[]>(
    [],
  );
  const [outOfStockOpen, setOutOfStockOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) router.push("/auth/login");
  }, [user, authLoading, router]);

  useEffect(() => {
    if (!user) return;
    // monthly trend and out-of-stock list are always global (no month filter)
    const month = selectedMonth || undefined;
    setLoading(true);
    Promise.all([
      fetchOverview(month),
      fetchProductsRanking(month),
      fetchSellersRanking(month),
      fetchMonthlyTrend(),
      fetchProducts(),
    ])
      .then(([ov, pr, sr, mt, allProducts]) => {
        setOverview(ov);
        setProducts(pr);
        setSellers(sr);
        setMonthly(mt);
        setOutOfStockProducts(
          (allProducts as ApiProduct[]).filter(
            (p) => p.status === "out_of_stock",
          ),
        );
      })
      .catch((err) => setError(getApiErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [user, selectedMonth]);

  if (authLoading || !user) return null;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Situation du business</h1>
          <p className="text-sm text-muted-foreground">
            {selectedMonth
              ? `Période : ${formatMonthLabel(selectedMonth)}`
              : "Vue globale · toutes périodes"}
          </p>
        </div>
        {monthly.length > 0 && (
          <select
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">Toutes périodes</option>
            {[...monthly].reverse().map((m) => (
              <option key={m.period} value={m.period}>
                {formatMonthLabel(m.period)}
              </option>
            ))}
          </select>
        )}
      </div>

      {loading && <p className="text-sm text-muted-foreground">Chargement…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {overview && (
        <>
          {/* KPIs */}
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
              Vue d&apos;ensemble
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <StatCard
                label="Capital investi"
                value={fmt(overview.totalInvested)}
              />
              <StatCard
                label="Chiffre d'affaires"
                value={fmt(overview.totalRevenue)}
              />
              <StatCard
                label="Bénéfice net"
                value={fmt(overview.netProfit)}
                sub={overview.netProfit >= 0 ? "✓ Positif" : "⚠ Négatif"}
              />
              <StatCard label="Marge moyenne" value={pct(overview.avgMargin)} />
              <StatCard
                label="Unités vendues"
                value={String(overview.unitsSold)}
              />
              <StatCard
                label="Transactions"
                value={String(overview.totalTransactions)}
              />
              <StatCard
                label="Stock faible"
                value={String(overview.lowStockCount)}
                sub="produits"
              />
              <StatCard
                label="Épuisés"
                value={String(overview.outOfStockCount)}
                sub={
                  overview.outOfStockCount > 0
                    ? "cliquer pour voir"
                    : "produits"
                }
                onClick={
                  overview.outOfStockCount > 0
                    ? () => setOutOfStockOpen(true)
                    : undefined
                }
              />
            </div>
          </section>

          {/* Monthly chart */}
          {monthly.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                Évolution mensuelle
              </h2>
              <Card>
                <CardContent className="pt-4 h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={monthly}>
                      <defs>
                        <linearGradient
                          id="gradRevenue"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="5%"
                            stopColor="#6366f1"
                            stopOpacity={0.3}
                          />
                          <stop
                            offset="95%"
                            stopColor="#6366f1"
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip formatter={(v) => fmt(Number(v ?? 0))} />
                      <Area
                        type="monotone"
                        dataKey="totalRevenue"
                        name="CA"
                        stroke="#6366f1"
                        fill="url(#gradRevenue)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </section>
          )}

          {/* Products ranking */}
          {products.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                Classement produits
              </h2>
              <Card>
                <CardContent className="pt-4 h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={products.slice(0, 8)} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" tick={{ fontSize: 11 }} />
                      <YAxis
                        type="category"
                        dataKey="productName"
                        width={100}
                        tick={{ fontSize: 11 }}
                      />
                      <Tooltip formatter={(v) => fmt(Number(v ?? 0))} />
                      <Legend />
                      <Bar dataKey="totalRevenue" name="CA" fill="#6366f1" />
                      <Bar dataKey="netProfit" name="Bénéfice" fill="#10b981" />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Table */}
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="text-left py-2 pr-4">Produit</th>
                      <th className="text-right py-2 px-2">Vendus</th>
                      <th className="text-right py-2 px-2">CA</th>
                      <th className="text-right py-2 px-2">Bénéfice</th>
                      <th className="text-right py-2">Restant</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p, i) => (
                      <tr
                        key={p.productId}
                        className="border-b hover:bg-muted/50"
                      >
                        <td className="py-2 pr-4 font-medium">
                          <span className="text-muted-foreground mr-2">
                            {i + 1}.
                          </span>
                          {p.productName}
                        </td>
                        <td className="text-right py-2 px-2">
                          {p.totalUnitsSold}
                        </td>
                        <td className="text-right py-2 px-2">
                          {fmt(p.totalRevenue)}
                        </td>
                        <td
                          className={`text-right py-2 px-2 font-semibold ${p.netProfit >= 0 ? "text-green-600" : "text-red-600"}`}
                        >
                          {fmt(p.netProfit)}
                        </td>
                        <td className="text-right py-2">
                          {p.remainingQuantity}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Sellers ranking */}
          {sellers.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                Classement vendeurs
              </h2>
              <div className="space-y-2">
                {sellers.map((s, i) => (
                  <Card key={s.sellerId}>
                    <CardContent className="py-3 flex items-center gap-4">
                      <span className="text-2xl font-bold text-muted-foreground w-8">
                        {i + 1}
                      </span>
                      <div className="flex-1">
                        <p className="font-semibold">{s.sellerName}</p>
                        <p className="text-xs text-muted-foreground">
                          {s.sellerEmail}
                        </p>
                      </div>
                      <div className="text-right text-sm space-y-0.5">
                        <p className="font-bold">{fmt(s.totalRevenue)}</p>
                        <p className="text-muted-foreground text-xs">
                          {s.totalUnitsSold} unités · {s.transactionCount}{" "}
                          ventes
                        </p>
                      </div>
                      {i === 0 && <Badge>🏆 Top</Badge>}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Modal produits épuisés */}
      <Dialog open={outOfStockOpen} onOpenChange={setOutOfStockOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Produits épuisés ({outOfStockProducts.length})
            </DialogTitle>
          </DialogHeader>
          {outOfStockProducts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              Aucun produit épuisé
            </p>
          ) : (
            <ul className="divide-y mt-2 max-h-96 overflow-y-auto">
              {outOfStockProducts.map((p) => (
                <li
                  key={p._id}
                  className="py-3 flex items-center justify-between gap-3"
                >
                  <div>
                    <p className="font-medium text-sm">{p.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Prix vente : {fmt(p.salePrice)} · {p.unitsSold} vendu(s)
                    </p>
                  </div>
                  <Link
                    href={`/products/${p._id}`}
                    onClick={() => setOutOfStockOpen(false)}
                    className="shrink-0 text-xs text-primary underline underline-offset-2 hover:no-underline"
                  >
                    Voir le produit →
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
