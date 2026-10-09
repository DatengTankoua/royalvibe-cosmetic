"use client";

import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import {
  ImageOffIcon,
  BadgeCheckIcon,
  AlertTriangleIcon,
  XCircleIcon,
  ShoppingCartIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Fragment } from "react";
import { productInfoItems } from "@/lib/product-info";
import type { OfflineCatalogProduct } from "@/lib/offline-catalog-db";
import { useIndicativeStock } from "@/contexts/offline-sales-context";

// 1-16G : libellés dans `catalog` (`status.*`).
const STATUS_CONFIG = {
  in_stock: { icon: BadgeCheckIcon, variant: "default" as const },
  low_stock: { icon: AlertTriangleIcon, variant: "secondary" as const },
  out_of_stock: { icon: XCircleIcon, variant: "destructive" as const },
};

// Carte produit hors ligne (1-11B) : uniquement les champs de l'allowlist
// persistée (stock/prix) — jamais d'image (réseau uniquement, placeholder
// affiché à la place) ni de métriques dérivées des ventes (unitsSold,
// bénéfice…), jamais d'action create/update/delete/upload. Navigation
// interne uniquement (onSelect) — jamais de route dynamique hors ligne.
// 1-11C.3 : stock indicatif si des ventes locales attendent l'envoi.
export function OfflineProductCard({
  product,
  snapshotUpdatedAt,
  onSelect,
  onSell,
}: {
  product: OfflineCatalogProduct;
  // Écriture du snapshot (ms) : borne des ventes déjà reflétées (1-11C.3).
  snapshotUpdatedAt?: number;
  onSelect: () => void;
  // 1-17B : « Vendre » (outbox locale), seulement si la capacité hors
  // connexion de saisie des ventes est valide (décidé par l'appelant).
  onSell?: () => void;
}) {
  const { t } = useT("catalog");
  const { fcfa } = useFormat();
  const status = STATUS_CONFIG[product.status] ? product.status : "in_stock";
  const cfg = STATUS_CONFIG[status];
  const StatusIcon = cfg.icon;
  // 1-11C.3 : snapshot moins ventes locales non confirmées (≥ 0).
  const indicative = useIndicativeStock(
    product._id,
    product.remainingQuantity,
    snapshotUpdatedAt,
  );
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={onSelect}
        className="flex aspect-video w-full items-center justify-center bg-muted text-muted-foreground"
      >
        <ImageOffIcon className="h-8 w-8" aria-hidden />
      </button>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm leading-tight">
            <button
              type="button"
              onClick={onSelect}
              className="text-left hover:underline"
            >
              {product.name}
            </button>
          </CardTitle>
          <Badge variant={cfg.variant} className="shrink-0 text-xs">
            <StatusIcon className="mr-1 h-3 w-3" />
            {t(`status.${status}`)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {/* 1-12H : informations standard uniquement (même source que la
            fiche en ligne). */}
        <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
          {productInfoItems(product, indicative, { t, fcfa }).map((item) => (
            <Fragment key={item.key}>
              <span className="text-muted-foreground">{item.label}</span>
              <span className="text-right font-medium">{item.value}</span>
            </Fragment>
          ))}
        </div>
        {onSell && (
          <Button
            size="sm"
            className="w-full"
            disabled={indicative.value === 0}
            aria-label={t("product.sellLabel", { name: product.name })}
            onClick={onSell}
          >
            <ShoppingCartIcon className="mr-1 h-3.5 w-3.5" aria-hidden />
            {t("product.sell")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
