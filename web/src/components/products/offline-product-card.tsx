import {
  ImageOffIcon,
  BadgeCheckIcon,
  AlertTriangleIcon,
  XCircleIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fmtXof } from "@/lib/currency";
import type { OfflineCatalogProduct } from "@/lib/offline-catalog-db";

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
export function OfflineProductCard({
  product,
  onSelect,
}: {
  product: OfflineCatalogProduct;
  onSelect: () => void;
}) {
  const cfg = STATUS_CONFIG[product.status] ?? STATUS_CONFIG.in_stock;
  const StatusIcon = cfg.icon;
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
        <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
          <span className="text-muted-foreground">Achat unitaire</span>
          <span className="text-right font-medium">
            {fmtXof(product.purchasePrice)}
          </span>
          <span className="text-muted-foreground">Vente unitaire</span>
          <span className="text-right font-medium">
            {fmtXof(product.salePrice)}
          </span>
          <span className="text-muted-foreground">Stock restant</span>
          <span className="text-right">
            {product.remainingQuantity} / {product.initialQuantity}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
