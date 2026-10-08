import type { Types } from 'mongoose';
import {
  DelegablePermission,
  hasPermission,
  OrganizationRole,
} from '../organizations/permissions';

/**
 * 1-12H — projection UNIQUE des informations produit selon les permissions
 * effectives. Toute réponse HTTP portant un produit passe par ici ; un champ
 * non autorisé est ABSENT (jamais remplacé par 0 ou une valeur inventée).
 *
 * - standard (tout membre autorisé à consulter) : nom, prix de vente cible,
 *   stock restant, statut ;
 * - `products.view_stock_details` : stock initial, unités vendues ;
 * - `products.view_financials` : prix d'achat unitaire, coût total d'achat,
 *   CA réel, bénéfice réel, marge.
 */
export interface ProductVisibility {
  stockDetails: boolean;
  financials: boolean;
}

/** Diffusion commune à toute l'organisation (Socket.IO) : standard seul. */
export const COMMON_VISIBILITY: ProductVisibility = Object.freeze({
  stockDetails: false,
  financials: false,
});

export function productVisibility(context: {
  role: OrganizationRole;
  permissions: readonly DelegablePermission[];
}): ProductVisibility {
  return {
    stockDetails: hasPermission(context, 'products.view_stock_details'),
    financials: hasPermission(context, 'products.view_financials'),
  };
}

export type ProductStatus = 'in_stock' | 'low_stock' | 'out_of_stock';

/** Champs lus sur le document (Mongoose ou objet simple). */
export interface ProductSource {
  _id: Types.ObjectId | string;
  sectionId: Types.ObjectId | string;
  name: string;
  purchasePrice: number;
  salePrice: number;
  initialQuantity: number;
  remainingQuantity: number;
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Produit projeté : allowlist explicite, jamais le document brut. */
export interface ProductView {
  _id: string;
  sectionId: string;
  name: string;
  /**
   * URL de lecture calculée à chaque réponse par le service (signée à durée
   * limitée, ou ancienne URL) ; `null` sans photo lisible. Jamais lue telle
   * quelle sur le document.
   */
  imageUrl: string | null;
  salePrice: number;
  remainingQuantity: number;
  deletedAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  initialQuantity?: number;
  purchasePrice?: number;
}

/**
 * Métriques d'un produit. `unitsSold` = stock initial − stock restant
 * (définition inchangée, indépendante du vendeur connecté). CA réel, bénéfice
 * et marge sont calculés sur l'agrégat serveur de TOUTES les ventes du
 * produit dans l'organisation (`actualRevenue`), jamais sur une liste
 * filtrée par vendeur ou paginée.
 */
export interface ProductMetricsView {
  product: ProductView;
  status: ProductStatus;
  unitsSold?: number;
  totalPurchaseCost?: number;
  actualRevenue?: number;
  actualProfit?: number;
  /** Bénéfice réel / CA réel × 100 ; `null` sans CA (non calculable). */
  margin?: number | null;
}

function num(value: unknown): number {
  // Garde NaN (documents malformés), comme l'ancien `withMetrics`.
  return Number(value) || 0;
}

export function computeStatus(p: ProductSource): ProductStatus {
  const remaining = num(p.remainingQuantity);
  const initial = num(p.initialQuantity);
  if (remaining === 0) return 'out_of_stock';
  if (initial > 0 && remaining / initial <= 0.2) return 'low_stock';
  return 'in_stock';
}

export function toProductView(
  p: ProductSource,
  visibility: ProductVisibility,
  imageUrl: string | null,
): ProductView {
  const view: ProductView = {
    _id: p._id.toString(),
    sectionId: p.sectionId.toString(),
    name: p.name,
    imageUrl,
    salePrice: p.salePrice,
    remainingQuantity: p.remainingQuantity,
    deletedAt: p.deletedAt ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
  if (visibility.stockDetails) view.initialQuantity = p.initialQuantity;
  if (visibility.financials) view.purchasePrice = p.purchasePrice;
  return view;
}

/**
 * `actualRevenue` n'est requis (et lu) que si `financials` : l'appelant ne
 * calcule jamais l'agrégat des ventes pour un membre sans ce droit.
 */
export function toProductMetricsView(
  p: ProductSource,
  visibility: ProductVisibility,
  imageUrl: string | null,
  actualRevenue?: number,
): ProductMetricsView {
  const view: ProductMetricsView = {
    product: toProductView(p, visibility, imageUrl),
    status: computeStatus(p),
  };
  const unitsSold = num(p.initialQuantity) - num(p.remainingQuantity);
  if (visibility.stockDetails) view.unitsSold = unitsSold;
  if (visibility.financials) {
    const buyPrice = num(p.purchasePrice);
    const revenue = num(actualRevenue);
    // Formules métier conservées (1-7B) : bénéfice réel = CA réel − prix
    // d'achat unitaire courant × unités vendues ; coût total = prix d'achat
    // × stock initial.
    const profit = revenue - buyPrice * unitsSold;
    view.totalPurchaseCost = buyPrice * num(p.initialQuantity);
    view.actualRevenue = revenue;
    view.actualProfit = profit;
    view.margin = revenue > 0 ? (profit / revenue) * 100 : null;
  }
  return view;
}

/**
 * Historique d'audit (`audit.read`) : les détails qui révèlent un champ
 * restreint sont retirés selon la même visibilité (prix d'achat ; stock
 * initial et quantités ajoutées).
 */
const FINANCIAL_AUDIT_KEYS = ['purchasePrice'];
const STOCK_DETAIL_AUDIT_KEYS = ['initialQuantity', 'added'];

export function projectAuditDetails(
  details: Record<string, unknown> | null | undefined,
  visibility: ProductVisibility,
): Record<string, unknown> | null | undefined {
  if (!details || typeof details !== 'object') return details;
  const hidden = [
    ...(visibility.financials ? [] : FINANCIAL_AUDIT_KEYS),
    ...(visibility.stockDetails ? [] : STOCK_DETAIL_AUDIT_KEYS),
  ];
  if (hidden.length === 0) return details;
  return Object.fromEntries(
    Object.entries(details).filter(([key]) => !hidden.includes(key)),
  );
}
