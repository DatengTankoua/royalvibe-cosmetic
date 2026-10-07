import type { TFunction } from "i18next";

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

// 1-16G : libellés dans `catalog` (`info.*`), montants formatés par
// l'appelant selon la langue (devise inchangée).
export interface ProductInfoFormat {
  t: TFunction<"catalog">;
  fcfa: (amount: number) => string;
}

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
  format: ProductInfoFormat,
  options: { showServerStock?: boolean } = {},
): ProductInfoItem[] {
  const { t, fcfa } = format;
  const items: ProductInfoItem[] = [
    {
      key: "salePrice",
      label: t("info.salePrice"),
      value: fcfa(product.salePrice),
    },
    {
      key: "stock",
      // Comportement 1-11C.3 conservé : stock serveur moins ventes locales
      // non confirmées, libellé « Stock indicatif » s'il y en a.
      label: stock.hasReservation
        ? t("info.indicativeStock")
        : t("info.remainingStock"),
      value:
        stock.hasReservation && options.showServerStock
          ? t("info.withServerStock", {
              value: stock.value,
              server: product.remainingQuantity,
            })
          : String(stock.value),
    },
  ];
  if (product.initialQuantity !== undefined) {
    items.push({
      key: "initialQuantity",
      label: t("info.initialQuantity"),
      value: String(product.initialQuantity),
    });
  }
  if (product.unitsSold !== undefined) {
    items.push({
      key: "unitsSold",
      label: t("info.unitsSold"),
      value: String(product.unitsSold),
    });
  }
  if (product.purchasePrice !== undefined) {
    items.push({
      key: "purchasePrice",
      label: t("info.purchasePrice"),
      value: fcfa(product.purchasePrice),
    });
  }
  if (product.totalPurchaseCost !== undefined) {
    items.push({
      key: "totalPurchaseCost",
      label: t("info.totalPurchaseCost"),
      value: fcfa(product.totalPurchaseCost),
    });
  }
  if (product.actualRevenue !== undefined) {
    items.push({
      key: "actualRevenue",
      label: t("info.actualRevenue"),
      value: fcfa(product.actualRevenue),
    });
  }
  if (product.actualProfit !== undefined) {
    items.push({
      key: "actualProfit",
      label: t("info.actualProfit"),
      value: fcfa(product.actualProfit),
      tone: product.actualProfit >= 0 ? "positive" : "negative",
    });
  }
  if (product.margin !== undefined) {
    items.push({
      key: "margin",
      label: t("info.margin"),
      // `null` = aucun CA : marge non calculable (affichage historique « — »).
      value: product.margin === null ? "—" : `${product.margin.toFixed(1)}%`,
    });
  }
  return items;
}
