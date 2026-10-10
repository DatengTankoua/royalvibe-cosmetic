"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { StoredImage } from "@/components/products/stored-image";
import type { TFunction } from "i18next";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
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
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import {
  useIndicativeStock,
  useOfflineSales,
} from "@/contexts/offline-sales-context";
import { hasPermission } from "@/lib/organization-permissions";
import { productInfoItems } from "@/lib/product-info";
import { useSaleInvalidation } from "@/hooks/use-sale-invalidation";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { useImageRenewal } from "@/hooks/use-image-renewal";
import { useSocket } from "@/contexts/socket-context";
import { createResponseOrder } from "@/lib/refresh-coordinator";

// 1-16G : libellés d'historique dans `catalog` (`audit.*`) ; une action
// inconnue reste affichée par son code (comportement inchangé).
const AUDIT_ACTIONS = [
  "created",
  "sold",
  "price_changed",
  "stock_changed",
  "name_changed",
  "section_changed",
  "deleted",
  "sale_updated",
  "sale_cancelled",
] as const;

function auditLabel(action: string, t: TFunction<"catalog">): string {
  return (AUDIT_ACTIONS as readonly string[]).includes(action)
    ? t(`audit.${action as (typeof AUDIT_ACTIONS)[number]}`)
    : action;
}

function ProfitIndicator({ profit }: { profit: number }) {
  const { t } = useT("catalog");
  if (profit > 0)
    return (
      <span className="flex items-center gap-1 text-green-700 dark:text-green-400 font-semibold">
        <TrendingUpIcon className="h-4 w-4" /> {t("profit.positive")}
      </span>
    );
  if (profit < 0)
    return (
      <span className="flex items-center gap-1 text-red-600 dark:text-red-400 font-semibold">
        <TrendingDownIcon className="h-4 w-4" /> {t("profit.negative")}
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-muted-foreground font-semibold">
      <MinusIcon className="h-4 w-4" /> {t("profit.even")}
    </span>
  );
}

function AuditEntry({ log }: { log: ApiAuditLog }) {
  const { t } = useT("catalog");
  const format = useFormat();
  const fmt = format.fcfa;
  return (
    <div className="flex gap-3 text-sm border-l-2 border-muted pl-3 py-1">
      <div className="flex-1">
        <p className="font-medium">{auditLabel(log.action, t)}</p>
        <p className="text-xs text-muted-foreground">
          {t("audit.by", { name: log.actorId?.name ?? "—" })} ·{" "}
          {format.dateTime(log.createdAt)}
        </p>
        {log.action === "sold" && log.details && (
          <p className="text-xs mt-0.5">
            {t("audit.unitsAt", {
              count: Number(log.details.quantity),
              price: fmt(Number(log.details.salePrice)),
            })}
            {log.details.buyerName ? ` — ${String(log.details.buyerName)}` : ""}
          </p>
        )}
        {log.action === "sale_cancelled" && log.details && (
          <p className="text-xs mt-0.5">
            {t("audit.unitsCancelled", {
              count: Number(log.details.quantity),
              price: fmt(Number(log.details.salePrice)),
            })}
          </p>
        )}
        {log.action === "sale_updated" && log.details && (
          <p className="text-xs mt-0.5">
            {log.details.quantity
              ? t("audit.quantityChange", {
                  from: (log.details.quantity as { from: number; to: number })
                    .from,
                  to: (log.details.quantity as { from: number; to: number }).to,
                })
              : ""}
            {log.details.quantity && log.details.salePrice ? " · " : ""}
            {log.details.salePrice
              ? t("audit.priceChange", {
                  from: fmt(
                    Number((log.details.salePrice as { from: number }).from),
                  ),
                  to: fmt(Number((log.details.salePrice as { to: number }).to)),
                })
              : ""}
          </p>
        )}
      </div>
    </div>
  );
}

// /app/catalog/products/[id] (1-9D, ex "/products/[id]") : enregistrer une
// vente → `sales.record` ; modifier/supprimer une vente → `sales.record` ET
// (`sales.view_all` OU vente propre à l'acteur) — jamais `User.role`. La
// liste des ventes/l'historique d'audit rendus sont déjà scopés par le
// backend (findOne), aucun filtrage supplémentaire côté client.
export default function ProductDetailPage() {
  const { t } = useT("catalog");
  const format = useFormat();
  const fmt = format.fcfa;
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { authContext } = useOrganizationShell();
  const canRecordSale = hasPermission(authContext, "sales.record");
  const canViewAllSales = hasPermission(authContext, "sales.view_all");
  const [detail, setDetail] = useState<ApiProductDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editSale, setEditSale] = useState<ApiSale | null>(null);
  // 1-15A : produit placé dans la corbeille par un autre membre.
  // 1-15B : ou supprimé définitivement (`product:purged`) — jamais présenté
  // comme restaurable, et plus aucune relecture appliquée ensuite.
  const [removal, setRemoval] = useState<"trashed" | "purged" | null>(null);
  const purgedRef = useRef(false);

  // 1-11C.3 : début de la dernière requête réussie (voir `reservesStock`).
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);
  // 1-15A : une réponse périmée n'écrase jamais une fiche plus récente.
  const order = useRef(createResponseOrder());

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (purgedRef.current) return;
      if (!options.silent) setIsLoading(true);
      const requestedAt = Date.now();
      const ticket = order.current.begin();
      try {
        const data = await fetchProduct(params.id);
        if (purgedRef.current) return;
        if (!order.current.accept(ticket)) return;
        setDetail(data);
        setRemoval(null);
        setError(null);
        setLoadedAt(requestedAt);
      } catch (err) {
        // Un rechargement silencieux en échec conserve la fiche affichée.
        if (!options.silent && !purgedRef.current) {
          setError(getApiErrorMessage(err));
        }
      } finally {
        if (!options.silent) setIsLoading(false);
      }
    },
    [params.id],
  );
  const reload = useCallback(() => load(), [load]);

  // 1-15A : relectures silencieuses regroupées, sérialisées, et rattrapage
  // après une reconnexion du socket.
  const scheduleRefresh = useLiveRefresh(
    () => load({ silent: true }),
    loadedAt,
  );
  // R2 privé : photo non chargeable (lien signé expiré) → relecture bornée.
  useImageRenewal(scheduleRefresh);

  // 1-12H (correctif) : vente d'un collègue (ou la sienne) sur ce produit →
  // stock, agrégats autorisés et historique scopé rechargés via l'API.
  useSaleInvalidation((productId) => productId === params.id, scheduleRefresh);

  // 1-15A : modification (prix, stock ajouté, nom), restauration ou mise à la
  // corbeille du produit par un autre membre. La diffusion ne porte que les
  // champs standard : la fiche est relue via l'API (permissions appliquées).
  const socket = useSocket();
  useEffect(() => {
    if (!socket) return;
    const productIdOf = (data: unknown): string | null => {
      const product =
        data && typeof data === "object" && "product" in data
          ? (data as { product?: { _id?: unknown } }).product
          : null;
      return typeof product?._id === "string" ? product._id : null;
    };
    const onChanged = (data: unknown) => {
      if (productIdOf(data) === params.id) scheduleRefresh();
    };
    // Toute réponse demandée AVANT l'événement est désormais périmée : une
    // relecture retenue ne fait pas réapparaître le produit.
    const invalidateInFlight = () =>
      order.current.accept(order.current.begin());
    const onDeleted = (id: unknown) => {
      if (id !== params.id || purgedRef.current) return;
      invalidateInFlight();
      setRemoval("trashed");
      setDetail(null);
    };
    const onPurged = (data: unknown) => {
      const id =
        data && typeof data === "object"
          ? (data as { _id?: unknown })._id
          : null;
      if (id !== params.id) return;
      purgedRef.current = true;
      invalidateInFlight();
      setRemoval("purged");
      setDetail(null);
      setError(null);
    };
    socket.on("product:updated", onChanged);
    socket.on("product:created", onChanged);
    socket.on("product:deleted", onDeleted);
    socket.on("product:purged", onPurged);
    return () => {
      socket.off("product:updated", onChanged);
      socket.off("product:created", onChanged);
      socket.off("product:deleted", onDeleted);
      socket.off("product:purged", onPurged);
    };
  }, [socket, params.id, scheduleRefresh]);

  useEffect(() => {
    void load();
  }, [load]);

  // 1-11C.3 : rechargement après confirmation serveur d'une vente locale.
  const { syncedVersion } = useOfflineSales();
  useEffect(() => {
    if (syncedVersion > 0) void load();
  }, [syncedVersion, load]);
  const indicative = useIndicativeStock(
    params.id,
    detail?.remainingQuantity ?? 0,
    loadedAt,
  );

  const canEditSale = (sale: ApiSale) =>
    canRecordSale &&
    (canViewAllSales || sale.sellerId._id === authContext?.userId);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-sm hover:bg-muted transition-colors"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          {t("actions.back")}
        </button>
      </div>

      {isLoading && (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      )}
      {!isLoading && removal === "trashed" && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("product.trashedNotice")}
        </p>
      )}
      {removal === "purged" && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("product.purgedNotice")}
        </p>
      )}
      {!isLoading && error && (
        <div className="flex items-center gap-3">
          <p className="text-sm text-destructive">{error}</p>
          <button
            onClick={() => void load()}
            className="text-sm text-primary underline underline-offset-2 hover:no-underline"
          >
            {t("actions.retry")}
          </button>
        </div>
      )}

      {!isLoading && detail && (
        <div className="space-y-6">
          {/* Hero */}
          <div className="flex gap-6 flex-col sm:flex-row">
            <div className="relative aspect-square w-full sm:w-48 rounded-xl overflow-hidden bg-muted shrink-0">
              <StoredImage
                src={detail.imageUrl}
                alt={detail.name}
                lazy={false}
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
                  {t(`status.${detail.status}`)}
                </Badge>
              </div>
              {detail.actualProfit !== undefined && (
                <ProfitIndicator profit={detail.actualProfit} />
              )}
              {canRecordSale && (
                <RecordSaleDialog
                  productId={detail._id}
                  productName={detail.name}
                  targetPrice={detail.salePrice}
                  remainingStock={detail.remainingQuantity}
                  serverLoadedAt={loadedAt}
                  // 1-20D : relecture REGROUPÉE avec le signal `sale:created`
                  // que l'auteur reçoit aussi (une seule relecture au lieu
                  // de deux) ; le stock indicatif couvre l'intervalle.
                  onSaleRecorded={scheduleRefresh}
                />
              )}
            </div>
          </div>

          {/* Metrics grid — 1-12H : champs projetés par l'API selon les
              permissions effectives, jamais complétés ici. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {productInfoItems(
              detail,
              indicative,
              { t, fcfa: fmt },
              { showServerStock: true },
            ).map((m) => (
              <Card key={m.key}>
                <CardContent className="pt-4 pb-3">
                  <p className="text-xs text-muted-foreground">{m.label}</p>
                  <p
                    className={`text-lg font-bold ${
                      m.tone === "positive"
                        ? "text-green-700 dark:text-green-400"
                        : m.tone === "negative"
                          ? "text-red-600 dark:text-red-400"
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
                <CardTitle className="text-base">
                  {t("product.recentSales")}
                </CardTitle>
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
                          {format.dateTime(s.createdAt)}
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
                        {canEditSale(s) && (
                          <button
                            onClick={() => setEditSale(s as ApiSale)}
                            className="mt-0.5 rounded p-1 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                            title={t("product.edit")}
                            aria-label={t("product.edit")}
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
              <CardTitle className="text-base">
                {t("product.history")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {(detail.auditLogs as ApiAuditLog[]).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("product.noHistory")}
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
        onUpdated={reload}
        onDeleted={reload}
      />
    </div>
  );
}
