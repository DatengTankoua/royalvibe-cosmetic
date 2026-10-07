/**
 * 1-16D — contenu d'un historique mensuel, indépendant du format (Excel ou
 * PDF). Une valeur INCONNUE est `null`, jamais 0 ; une colonne non
 * autorisée par les droits du compte est absente (`undefined`).
 */

export type ProductState = 'available' | 'trash' | 'deleted';

export interface MonthlyHistorySaleLine {
  /** Date métier : `occurredAt`, sinon `createdAt` (règle de l'Analyse). */
  date: Date;
  /** Nom enregistré lors de la vente (1-15D) ; `null` s'il ne l'a pas été. */
  recordedName: string | null;
  /**
   * Nom actuel du produit s'il existe encore, sinon dernier nom connu figé à
   * la purge ; `null` si aucun. Renseigné seulement s'il diffère du nom
   * enregistré ou si celui-ci manque.
   */
  otherName: string | null;
  productState: ProductState;
  quantity: number;
  unitPrice: number;
  amount: number;
  /** Nom actuel du compte vendeur ; `null` si le compte n'existe plus. */
  sellerName: string | null;
  /** Données acheteur : présentes seulement si les droits l'autorisent. */
  buyerName?: string | null;
  buyerContact?: string | null;
}

export interface MonthlyHistoryProductLine {
  name: string | null;
  productState: ProductState;
  quantity: number;
  salesCount: number;
  revenue: number;
  /** Gain estimé de l'Analyse ; `null` = inconnu ; absent sans le droit. */
  gain?: number | null;
}

export interface MonthlyHistorySellerLine {
  name: string | null;
  quantity: number;
  salesCount: number;
  revenue: number;
}

export interface MonthlyHistoryMovementLine {
  date: Date;
  kind: 'correction' | 'cancellation';
  productName: string | null;
  productDeleted: boolean;
  /** Date de la vente corrigée si elle existe encore ; sinon `null`. */
  saleDate: Date | null;
  quantityBefore: number | null;
  quantityAfter: number | null;
  priceBefore: number | null;
  priceAfter: number | null;
  actorName: string | null;
}

export interface MonthlyHistory {
  organization: { name: string; slug: string };
  period: {
    month: string;
    start: Date;
    /** Fin EXCLUE (1er jour du mois suivant, 00:00). */
    end: Date;
    timeZone: string;
    isCurrentMonth: boolean;
  };
  generatedAt: Date;
  generatedBy: string | null;
  rights: { financials: boolean; buyers: boolean };
  summary: {
    revenue: number;
    quantity: number;
    salesCount: number;
    productsSold: number;
    sellers: number;
    /** Somme des gains par produit ; `null` si l'un est inconnu. */
    estimatedGain?: number | null;
    corrections: number;
    cancellations: number;
  };
  sales: MonthlyHistorySaleLine[];
  products: MonthlyHistoryProductLine[];
  sellers: MonthlyHistorySellerLine[];
  movements: MonthlyHistoryMovementLine[];
}
