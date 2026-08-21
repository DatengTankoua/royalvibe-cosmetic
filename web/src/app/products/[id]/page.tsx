"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import {
  ArrowLeftIcon,
  TrendingUpIcon,
  TrendingDownIcon,
  MinusIcon,
  PencilIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RecordSaleDialog } from "@/components/products/record-sale-dialog";
import { EditSaleDialog } from "@/components/products/edit-sale-dialog";
import {
  fetchProduct,
  getApiErrorMessage,
  type ApiProductDetail,
  type ApiAuditLog,
  type ApiSale,
} from "@/lib/api";
import { useAuth } from "@/contexts/auth-context";
import { fmtXof } from "@/lib/currency";

const fmt = fmtXof;

const AUDIT_LABELS: Record<string, string> = {
  created: "Produit ajouté",
  sold: "Vente",
  price_changed: "Prix modifié",
  stock_changed: "Stock ajouté",
  name_changed: "Nom modifié",
  section_changed: "Section changée",
  deleted: "Produit supprimé",
  sale_updated: "Vente modifiée",
  sale_cancelled: "Vente annulée",
};

function ProfitIndicator({ profit }: { profit: number }) {
  if (profit > 0)
    return (
      <span className="flex items-center gap-1 text-green-600 font-semibold">
        <TrendingUpIcon className="h-4 w-4" /> Rentable
      </span>
    );
  if (profit < 0)
    return (
      <span className="flex items-center gap-1 text-red-600 font-semibold">
        <TrendingDownIcon className="h-4 w-4" /> À perte
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-muted-foreground font-semibold">
      <MinusIcon className="h-4 w-4" /> À l&apos;équilibre
    </span>
  );
}

function AuditEntry({ log }: { log: ApiAuditLog }) {
  return (
    <div className="flex gap-3 text-sm border-l-2 border-muted pl-3 py-1">
      <div className="flex-1">
        <p className="font-medium">{AUDIT_LABELS[log.action] ?? log.action}</p>
        <p className="text-xs text-muted-foreground">
          par {log.actorId?.name ?? "—"} ·{" "}
          {new Date(log.createdAt).toLocaleString("fr-FR")}
        </p>
        {log.action === "sold" && log.details && (
          <p className="text-xs mt-0.5">
            {String(log.details.quantity)} unité(s) à{" "}
            {fmt(Number(log.details.salePrice))}
            {log.details.buyerName ? ` — ${String(log.details.buyerName)}` : ""}
          </p>
        )}
        {log.action === "sale_cancelled" && log.details && (
          <p className="text-xs mt-0.5">
            {String(log.details.quantity)} unité(s) à{" "}
            {fmt(Number(log.details.salePrice))} annulée(s)
          </p>
        )}
        {log.action === "sale_updated" && log.details && (
          <p className="text-xs mt-0.5">
            {log.details.quantity
              ? `Qté : ${(log.details.quantity as { from: number; to: number }).from} → ${(log.details.quantity as { from: number; to: number }).to}`
              : ""}
            {log.details.quantity && log.details.salePrice ? " · " : ""}
            {log.details.salePrice
              ? `Prix : ${fmt(Number((log.details.salePrice as { from: number }).from))} → ${fmt(Number((log.details.salePrice as { to: number }).to))}`
              : ""}
          </p>
        )}
      </div>
    </div>
  );
}

export default function ProductDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();
  const [detail, setDetail] = useState<ApiProductDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editSale, setEditSale] = useState<ApiSale | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchProduct(params.id);
      setDetail(data);
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    if (!authLoading && !user) router.push("/auth/login");
  }, [user, authLoading, router]);

  useEffect(() => {
    void load();
  }, [load]);

  if (authLoading || !user) return null;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-sm hover:bg-muted transition-colors"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          Retour
        </button>
      </div>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      )}
      {!isLoading && error && (
        <div className="flex items-center gap-3">
          <p className="text-sm text-destructive">{error}</p>
          <button
            onClick={() => void load()}
            className="text-sm text-primary underline underline-offset-2 hover:no-underline"
          >
            Réessayer
          </button>
        </div>
      )}

      {!isLoading && detail && (
        <div className="space-y-6">
          {/* Hero */}
          <div className="flex gap-6 flex-col sm:flex-row">
            <div className="relative aspect-square w-full sm:w-48 rounded-xl overflow-hidden bg-muted shrink-0">
              <Image
                src={detail.imageUrl}
                alt={detail.name}
                fill
                unoptimized
                className="object-cover"
              />
            </div>
            <div className="flex flex-col gap-3 flex-1">
              <div className="flex items-start justify-between gap-2">
                <h1 className="text-2xl font-bold">{detail.name}</h1>
                <Badge
                  variant={
                    detail.status === "in_stock"
                      ? "default"
                      : detail.status === "low_stock"
                        ? "secondary"
                        : "destructive"
                  }
                >
                  {detail.status === "in_stock"
                    ? "En stock"
                    : detail.status === "low_stock"
                      ? "Stock faible"
                      : "Épuisé"}
                </Badge>
              </div>
              <ProfitIndicator profit={detail.actualProfit} />
              <RecordSaleDialog
                productId={detail._id}
                productName={detail.name}
                targetPrice={detail.salePrice}
                remainingStock={detail.remainingQuantity}
                onSaleRecorded={load}
              />
            </div>
          </div>

          {/* Metrics grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              {
                label: "Prix d'achat unitaire",
                value: fmt(detail.purchasePrice),
              },
              { label: "Prix de vente cible", value: fmt(detail.salePrice) },
              { label: "Stock initial", value: detail.initialQuantity },
              { label: "Stock restant", value: detail.remainingQuantity },
              { label: "Unités vendues", value: detail.unitsSold },
              {
                label: "Coût total d'achat",
                value: fmt(detail.totalPurchaseCost),
              },
              { label: "CA réel", value: fmt(detail.actualRevenue) },
              {
                label: "Bénéfice réel",
                value: fmt(detail.actualProfit),
                highlight: detail.actualProfit >= 0 ? "green" : "red",
              },
              {
                label: "Marge",
                value:
                  detail.actualRevenue > 0
                    ? `${((detail.actualProfit / detail.actualRevenue) * 100).toFixed(1)}%`
                    : "—",
              },
            ].map((m) => (
              <Card key={m.label}>
                <CardContent className="pt-4 pb-3">
                  <p className="text-xs text-muted-foreground">{m.label}</p>
                  <p
                    className={`text-lg font-bold ${
                      m.highlight === "green"
                        ? "text-green-600"
                        : m.highlight === "red"
                          ? "text-red-600"
                          : ""
                    }`}
                  >
                    {m.value}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Sellers for this product */}
          {detail.sales.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Ventes récentes</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="divide-y text-sm">
                  {detail.sales.slice(0, 10).map((s) => (
                    <div
                      key={s._id}
                      className="py-2 flex justify-between gap-2"
                    >
                      <div>
                        <p className="font-medium">
                          {typeof s.sellerId === "object"
                            ? s.sellerId.name
                            : "—"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(s.createdAt).toLocaleString("fr-FR")}
                          {s.buyerName ? ` → ${s.buyerName}` : ""}
                        </p>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="text-right shrink-0">
                          <p>
                            {s.quantity} × {fmt(s.salePrice)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            = {fmt(s.quantity * s.salePrice)}
                          </p>
                        </div>
                        {user.role === "admin" && (
                          <button
                            onClick={() => setEditSale(s as ApiSale)}
                            className="mt-0.5 rounded p-1 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                            title="Modifier"
                          >
                            <PencilIcon className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Audit trail */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Historique complet</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {(detail.auditLogs as ApiAuditLog[]).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Aucun historique
                </p>
              ) : (
                (detail.auditLogs as ApiAuditLog[]).map((log) => (
                  <AuditEntry key={log._id} log={log} />
                ))
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <EditSaleDialog
        sale={editSale}
        open={editSale !== null}
        onOpenChange={(v) => {
          if (!v) setEditSale(null);
        }}
        onUpdated={load}
        onDeleted={load}
      />
    </div>
  );
}
