import { fmtXof } from "@/lib/currency";

// 1-12H — source UNIQUE des informations produit affichées (fiche, cartes,
// modal du catalogue, hors ligne). Ne décide rien : l'API a déjà projeté le
// produit selon les permissions effectives, un champ absent n'est jamais
// rendu (ni remplacé par 0) — aucune condition contradictoire par vue.

export type ProductInfoKey =
  | "salePrice"
  | "stock"
  | "initialQuantity"
  | "unitsSold"
  | "purchasePrice"
  | "totalPurchaseCost"
  | "actualRevenue"
  | "actualProfit"
  | "margin";

export interface ProductInfoItem {
  key: ProductInfoKey;
  label: string;
  value: string;
  tone?: "positive" | "negative";
}

/** Champs lus : tous optionnels sauf le standard (prix cible, stock). */
export interface ProductInfoSource {
  salePrice: number;
  remainingQuantity: number;
  initialQuantity?: number;
  unitsSold?: number;
  purchasePrice?: number;
  totalPurchaseCost?: number;
  actualRevenue?: number;
  actualProfit?: number;
  margin?: number | null;
}

export interface IndicativeStock {
  value: number;
  hasReservation: boolean;
}

export function productInfoItems(
  product: ProductInfoSource,
  stock: IndicativeStock,
  options: { showServerStock?: boolean } = {},
): ProductInfoItem[] {
  const items: ProductInfoItem[] = [
    {
      key: "salePrice",
      label: "Prix de vente cible",
      value: fmtXof(product.salePrice),
    },
    {
      key: "stock",
      // Comportement 1-11C.3 conservé : stock serveur moins ventes locales
      // non confirmées, libellé « Stock indicatif » s'il y en a.
      label: stock.hasReservation ? "Stock indicatif" : "Stock restant",
      value:
        stock.hasReservation && options.showServerStock
          ? `${stock.value} (serveur : ${product.remainingQuantity})`
          : String(stock.value),
    },
  ];
  if (product.initialQuantity !== undefined) {
    items.push({
      key: "initialQuantity",
      label: "Stock initial",
      value: String(product.initialQuantity),
    });
  }
  if (product.unitsSold !== undefined) {
    items.push({
      key: "unitsSold",
      label: "Unités vendues",
      value: String(product.unitsSold),
    });
  }
  if (product.purchasePrice !== undefined) {
    items.push({
      key: "purchasePrice",
      label: "Prix d'achat unitaire",
      value: fmtXof(product.purchasePrice),
    });
  }
  if (product.totalPurchaseCost !== undefined) {
    items.push({
      key: "totalPurchaseCost",
      label: "Coût total d'achat",
      value: fmtXof(product.totalPurchaseCost),
    });
  }
  if (product.actualRevenue !== undefined) {
    items.push({
      key: "actualRevenue",
      label: "CA réel",
      value: fmtXof(product.actualRevenue),
    });
  }
  if (product.actualProfit !== undefined) {
    items.push({
      key: "actualProfit",
      label: "Bénéfice réel",
      value: fmtXof(product.actualProfit),
      tone: product.actualProfit >= 0 ? "positive" : "negative",
    });
  }
  if (product.margin !== undefined) {
    items.push({
      key: "margin",
      label: "Marge",
      // `null` = aucun CA : marge non calculable (affichage historique « — »).
      value: product.margin === null ? "—" : `${product.margin.toFixed(1)}%`,
    });
  }
  return items;
}
