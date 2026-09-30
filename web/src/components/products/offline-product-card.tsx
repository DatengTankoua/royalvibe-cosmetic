import {
  ImageOffIcon,
  BadgeCheckIcon,
  AlertTriangleIcon,
  XCircleIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Fragment } from "react";
import { productInfoItems } from "@/lib/product-info";
import type { OfflineCatalogProduct } from "@/lib/offline-catalog-db";
import { useIndicativeStock } from "@/contexts/offline-sales-context";

const STATUS_CONFIG = {
  in_stock: {
    label: "En stock",
    icon: BadgeCheckIcon,
    variant: "default" as const,
  },
  low_stock: {
    label: "Stock faible",
    icon: AlertTriangleIcon,
    variant: "secondary" as const,
  },
  out_of_stock: {
    label: "Épuisé",
    icon: XCircleIcon,
    variant: "destructive" as const,
  },
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
}: {
  product: OfflineCatalogProduct;
  // Écriture du snapshot (ms) : borne des ventes déjà reflétées (1-11C.3).
  snapshotUpdatedAt?: number;
  onSelect: () => void;
}) {
  const cfg = STATUS_CONFIG[product.status] ?? STATUS_CONFIG.in_stock;
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
            {cfg.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {/* 1-12H : informations standard uniquement (même source que la
            fiche en ligne). */}
        <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
          {productInfoItems(product, indicative).map((item) => (
            <Fragment key={item.key}>
              <span className="text-muted-foreground">{item.label}</span>
              <span className="text-right font-medium">{item.value}</span>
            </Fragment>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
