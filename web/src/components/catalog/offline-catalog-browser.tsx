"use client";

import { useMemo, useState } from "react";
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
import { fmtXof } from "@/lib/currency";
import {
  scopeKey,
  type CatalogScope,
  type OfflineCatalogSnapshot,
} from "@/lib/offline-catalog-db";

const STATUS_LABEL = {
  in_stock: "En stock",
  low_stock: "Stock faible",
  out_of_stock: "Épuisé",
} as const;

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
          {stack.length > 1 ? stack[stack.length - 2].name : "Catalogue"}
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
          {scopeSynced
            ? "Aucun élément."
            : "Cette section n'est pas disponible sur cet appareil."}
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
                  {STATUS_LABEL[openProduct.status]}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                <span className="text-muted-foreground">Achat unitaire</span>
                <span className="text-right font-medium">
                  {fmtXof(openProduct.purchasePrice)}
                </span>
                <span className="text-muted-foreground">Vente unitaire</span>
                <span className="text-right font-medium">
                  {fmtXof(openProduct.salePrice)}
                </span>
                <OfflineStockRows
                  productId={openProduct._id}
                  remaining={openProduct.remainingQuantity}
                  loadedAt={snapshotUpdatedAt}
                  initial={openProduct.initialQuantity}
                />
              </div>
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
                Historique et analyses indisponibles hors connexion. Le stock
                affiché peut ne plus être à jour.
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

function OfflineStockRows({
  productId,
  remaining,
  initial,
  loadedAt,
}: {
  productId: string;
  remaining: number;
  initial: number;
  loadedAt?: number;
}) {
  const indicative = useIndicativeStock(productId, remaining, loadedAt);
  return (
    <>
      <span className="text-muted-foreground">
        {indicative.hasReservation ? "Stock indicatif" : "Stock restant"}
      </span>
      <span className="text-right">
        {indicative.value} / {initial}
      </span>
    </>
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
  const indicative = useIndicativeStock(productId, remaining, loadedAt);
  return (
    <Button size="sm" onClick={onClick} disabled={indicative.value === 0}>
      <ShoppingCartIcon className="mr-1 h-4 w-4" />
      Enregistrer une vente
    </Button>
  );
}
