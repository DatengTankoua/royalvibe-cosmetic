"use client";

import { Fragment, useMemo, useState } from "react";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import {
  ArrowLeftIcon,
  FolderIcon,
  ImageOffIcon,
  ShoppingCartIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { OfflineProductCard } from "@/components/products/offline-product-card";
import { SaleFormDialog } from "@/components/products/record-sale-dialog";
import { Button } from "@/components/ui/button";
import {
  useIndicativeStock,
  useOfflineSales,
} from "@/contexts/offline-sales-context";
import { productInfoItems } from "@/lib/product-info";
import {
  scopeKey,
  type CatalogScope,
  type OfflineCatalogProduct,
  type OfflineCatalogSnapshot,
} from "@/lib/offline-catalog-db";

const STATUS_VARIANT = {
  in_stock: "default",
  low_stock: "secondary",
  out_of_stock: "destructive",
} as const;

// Navigateur de catalogue hors ligne (1-11B, correction) : navigation
// interne en mémoire dans le snapshot déjà synchronisé — jamais de
// `router.push`/`Link` vers une route dynamique (/app/catalog/[id],
// /app/catalog/products/[id]) tant qu'on est hors ligne. Aucune action
// create/update/delete/upload sur le catalogue. 1-11C.3 : seule action
// possible, la saisie d'une vente dans l'outbox locale, et uniquement si
// la capacité hors ligne `canRecordSales` est valide.
export function OfflineCatalogBrowser({
  snapshot,
}: {
  snapshot: OfflineCatalogSnapshot;
}) {
  const { t } = useT("catalog");
  const [stack, setStack] = useState<{ id: string; name: string }[]>([]);
  const [productId, setProductId] = useState<string | null>(null);
  const [saleProductId, setSaleProductId] = useState<string | null>(null);
  const { canRecordSales } = useOfflineSales();
  const parsedUpdatedAt = Date.parse(snapshot.updatedAt);
  const snapshotUpdatedAt = Number.isNaN(parsedUpdatedAt)
    ? undefined
    : parsedUpdatedAt;

  const currentParentId = stack.length ? stack[stack.length - 1].id : null;

  const childSections = useMemo(
    () => snapshot.sections.filter((s) => s.parentId === currentParentId),
    [snapshot.sections, currentParentId],
  );
  const products = useMemo(
    () =>
      currentParentId
        ? snapshot.products.filter((p) => p.sectionId === currentParentId)
        : [],
    [snapshot.products, currentParentId],
  );

  const childrenScope: CatalogScope = currentParentId
    ? { kind: "section-children", sectionId: currentParentId }
    : { kind: "root-sections" };
  const childrenSynced = snapshot.syncedScopes.includes(
    scopeKey(childrenScope),
  );
  const productsSynced = currentParentId
    ? snapshot.syncedScopes.includes(
        scopeKey({ kind: "section-products", sectionId: currentParentId }),
      )
    : true;
  const scopeSynced = childrenSynced || productsSynced;

  const openProduct = productId
    ? (snapshot.products.find((p) => p._id === productId) ?? null)
    : null;
  const saleProduct = saleProductId
    ? (snapshot.products.find((p) => p._id === saleProductId) ?? null)
    : null;

  return (
    <div className="space-y-4">
      {stack.length > 0 && (
        <button
          type="button"
          onClick={() => setStack((s) => s.slice(0, -1))}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-sm hover:bg-muted"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          {stack.length > 1 ? stack[stack.length - 2].name : t("root.title")}
        </button>
      )}

      {childSections.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {childSections.map((s) => (
            <Card
              key={s._id}
              role="button"
              tabIndex={0}
              onClick={() =>
                setStack((prev) => [...prev, { id: s._id, name: s.name }])
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  setStack((prev) => [...prev, { id: s._id, name: s.name }]);
                }
              }}
              className="cursor-pointer hover:shadow-md transition-shadow"
            >
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <FolderIcon className="h-4 w-4 shrink-0" />
                  {s.name}
                </CardTitle>
              </CardHeader>
              {s.description && (
                <CardContent className="pt-0 text-xs text-muted-foreground">
                  {s.description}
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}

      {childSections.length === 0 && products.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {products.map((p) => (
            <OfflineProductCard
              key={p._id}
              product={p}
              snapshotUpdatedAt={snapshotUpdatedAt}
              onSelect={() => setProductId(p._id)}
            />
          ))}
        </div>
      )}

      {childSections.length === 0 && products.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {scopeSynced ? t("offline.empty") : t("offline.sectionUnavailable")}
        </p>
      )}

      <Dialog
        open={openProduct !== null}
        onOpenChange={(v) => !v && setProductId(null)}
      >
        <DialogContent>
          {openProduct && (
            <>
              <DialogHeader>
                <DialogTitle>{openProduct.name}</DialogTitle>
              </DialogHeader>
              <div className="flex items-center justify-between gap-2">
                <div className="flex aspect-square w-20 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <ImageOffIcon className="h-6 w-6" aria-hidden />
                </div>
                <Badge variant={STATUS_VARIANT[openProduct.status]}>
                  {t(`status.${openProduct.status}`)}
                </Badge>
              </div>
              <OfflineProductInfo
                product={openProduct}
                loadedAt={snapshotUpdatedAt}
              />
              {canRecordSales && (
                <OfflineSaleButton
                  productId={openProduct._id}
                  remaining={openProduct.remainingQuantity}
                  loadedAt={snapshotUpdatedAt}
                  onClick={() => {
                    setSaleProductId(openProduct._id);
                    setProductId(null);
                  }}
                />
              )}
              <p className="text-xs text-muted-foreground">
                {t("offline.productNote")}
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>

      {saleProduct && (
        <SaleFormDialog
          key={saleProduct._id}
          open
          onOpenChange={(v) => !v && setSaleProductId(null)}
          productId={saleProduct._id}
          productName={saleProduct.name}
          targetPrice={saleProduct.salePrice}
          remainingStock={saleProduct.remainingQuantity}
          serverLoadedAt={snapshotUpdatedAt}
        />
      )}
    </div>
  );
}

// 1-12H : modal hors ligne — informations standard seulement, via la même
// source que la fiche en ligne (stock indicatif conservé).
function OfflineProductInfo({
  product,
  loadedAt,
}: {
  product: OfflineCatalogProduct;
  loadedAt?: number;
}) {
  const { t } = useT("catalog");
  const { fcfa } = useFormat();
  const indicative = useIndicativeStock(
    product._id,
    product.remainingQuantity,
    loadedAt,
  );
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
      {productInfoItems(product, indicative, { t, fcfa }).map((item) => (
        <Fragment key={item.key}>
          <span className="text-muted-foreground">{item.label}</span>
          <span className="text-right font-medium">{item.value}</span>
        </Fragment>
      ))}
    </div>
  );
}

function OfflineSaleButton({
  productId,
  remaining,
  loadedAt,
  onClick,
}: {
  productId: string;
  remaining: number;
  loadedAt?: number;
  onClick: () => void;
}) {
  const { t } = useT("sales");
  const indicative = useIndicativeStock(productId, remaining, loadedAt);
  return (
    <Button size="sm" onClick={onClick} disabled={indicative.value === 0}>
      <ShoppingCartIcon className="mr-1 h-4 w-4" />
      {t("form.record")}
    </Button>
  );
}
