import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale, SaleDocument } from '../sales/schemas/sale.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import {
  PurgedStockAdjustment,
  PurgedStockAdjustmentDocument,
} from '../products/schemas/purged-stock-adjustment.schema';
import {
  Organization,
  OrganizationDocument,
} from '../organizations/schemas/organization.schema';
import {
  monthBounds,
  processTimeZone,
  saleMonthMatch,
  saleRangeMatch,
} from './month-range';
import { INSIGHT_THRESHOLDS } from './insight-thresholds';
import {
  addLocalDays,
  assignPrimaryPriority,
  buildPriorities,
  civilDaysBetween,
  changePercent,
  classifyStock,
  comparisonWindow,
  estimateSalesRate,
  localDayKey,
  localMonthKey,
  noRecentSaleKind,
  observationWindow,
  pageOf,
  type ProductDayRow,
  type SalesRateEstimate,
} from './insights';

/**
 * 1-11C.1 — date métier d'une vente : `occurredAt` (heure réelle, possiblement
 * antérieure à la synchronisation hors ligne), sinon `createdAt` pour les
 * ventes antérieures à ce champ.
 */
const SALE_EFFECTIVE_DATE = { $ifNull: ['$occurredAt', '$createdAt'] };

/**
 * 1-15D — coût figé des unités d'une vente de produit supprimé
 * (`lastKnownUnitCost` × quantité), et unités dont ce coût est inconnu.
 * Accumulateurs `$group` : un coût absent ne vaut jamais 0 dans un résultat,
 * il rend le bénéfice inconnu (`unknownCostUnits > 0`).
 */
const SALE_PURGED_COST = {
  $sum: { $multiply: [{ $ifNull: ['$lastKnownUnitCost', 0] }, '$quantity'] },
};
const SALE_UNKNOWN_COST_UNITS = {
  $sum: { $cond: [{ $isNumber: '$lastKnownUnitCost' }, 0, '$quantity'] },
};

/** Ligne du classement par produit (agrégation `rankingFor`). */
export interface ProductRankingRow {
  productId: Types.ObjectId;
  productName: string | null;
  productDeleted: boolean;
  /** Stock courant ; `null` pour un produit supprimé. */
  remainingQuantity: number | null;
  totalUnitsSold: number;
  totalRevenue: number;
  /** `null` : coût inconnu (jamais 0). */
  netProfit: number | null;
  transactionCount: number;
}

/** 1-16E — droits relus par le contrôleur pour CETTE requête. */
export interface InsightRights {
  /** `analytics.read` ET `products.view_financials`. */
  financials: boolean;
}

/** Totaux d'une période ; `gain` absent sans droit financier. */
export interface PeriodTotals {
  revenue: number;
  salesCount: number;
  unitsSold: number;
  gain?: number | null;
}

/** Produit d'une liste de stock ou de produits sans vente récente. */
export interface InsightStockItem {
  productId: string;
  name: string;
  sectionId: string;
  remainingQuantity: number;
  estimate: SalesRateEstimate;
}

/** Champs d'un produit disponible lus par `getInsights`. */
interface InsightProductSource {
  _id: Types.ObjectId;
  name: string;
  sectionId: Types.ObjectId;
  remainingQuantity: number;
  initialQuantity: number;
  purchasePrice: number;
  createdAt?: Date;
}

export interface InsightPriceItem {
  productId: string;
  name: string;
  sectionId: string;
  revenue: number;
  unitsSold: number;
  purchasePrice: number;
  gain: number;
}

/** 1-16E — listes paginables de « Stock actuel ». */
export const INSIGHT_LIST_KINDS = [
  'out',
  'soon',
  'price',
  'low',
  'stale',
  'recent',
] as const;
export type InsightListKind = (typeof INSIGHT_LIST_KINDS)[number];

/** Départage final : nom (fr), puis identifiant (ordre total et stable). */
function stableOrder(
  a: { name: string; productId: string },
  b: { name: string; productId: string },
): number {
  return (
    a.name.localeCompare(b.name, 'fr') ||
    (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0)
  );
}

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectModel(Sale.name) private saleModel: Model<SaleDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(PurgedStockAdjustment.name)
    private stockAdjustmentModel: Model<PurgedStockAdjustmentDocument>,
    @InjectModel(Organization.name)
    private organizationModel: Model<OrganizationDocument>,
  ) {}

  async getOverview(organizationId: string, month?: string) {
    const organizationOid = new Types.ObjectId(organizationId);
    const matchStage = {
      organizationId: organizationOid,
      ...(month ? this.monthMatch(month) : {}),
    };

    const [salesAgg, products, purged, stockAdjustment] = await Promise.all([
      this.saleModel.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: { $multiply: ['$salePrice', '$quantity'] } },
            totalUnitsSold: { $sum: '$quantity' },
            totalTransactions: { $sum: 1 },
          },
        },
      ]),
      this.productModel.find({ organizationId: organizationOid }).exec(),
      this.purgedProductsCost(organizationOid),
      this.purgedStockAdjustmentCost(organizationOid),
    ]);

    const totalInvested = products.reduce(
      (s, p) => s + p.purchasePrice * p.initialQuantity,
      0,
    );
    const revenue: number = salesAgg[0]?.totalRevenue ?? 0;
    const unitsSold = salesAgg[0]?.totalUnitsSold ?? 0;
    const transactions = salesAgg[0]?.totalTransactions ?? 0;

    const { netProfit, avgMargin } = month
      ? await this.monthlyEstimatedProfit(organizationId, month, revenue)
      : this.allPeriodsProfit(products, purged, stockAdjustment, revenue);

    return {
      totalInvested,
      totalRevenue: revenue,
      netProfit,
      avgMargin,
      unitsSold,
      totalTransactions: transactions,
      productsCount: products.length,
      lowStockCount: products.filter(
        (p) =>
          p.remainingQuantity > 0 &&
          p.remainingQuantity / p.initialQuantity <= 0.2,
      ).length,
      outOfStockCount: products.filter((p) => p.remainingQuantity === 0).length,
    };
  }

  /**
   * Vue globale (sans filtre de mois) : règle existante, inchangée.
   * Coût des ventes = prix d'achat × (stock initial − restant) des produits
   * présents ; 1-15D : + coût figé des ventes de produits supprimés + écarts
   * figés à la purge. Un coût de produit supprimé inconnu rend le bénéfice
   * INCONNU (`null`), jamais calculé avec un coût nul.
   */
  private allPeriodsProfit(
    products: ReadonlyArray<{
      purchasePrice: number;
      initialQuantity: number;
      remainingQuantity: number;
    }>,
    purged: { cost: number; unknownCostUnits: number },
    stockAdjustment: number,
    revenue: number,
  ): { netProfit: number | null; avgMargin: number | null } {
    const totalCOGS =
      products.reduce((s, p) => {
        const sold = p.initialQuantity - p.remainingQuantity;
        return s + p.purchasePrice * sold;
      }, 0) +
      purged.cost +
      stockAdjustment;
    if (purged.unknownCostUnits !== 0) {
      return { netProfit: null, avgMargin: null };
    }
    return {
      netProfit: revenue - totalCOGS,
      avgMargin: revenue > 0 ? ((revenue - totalCOGS) / revenue) * 100 : 0,
    };
  }

  /**
   * 1-16D — gain estimé d'UN mois : somme des gains du classement par
   * produit de ce mois (`getProductsRanking`), soit pour chaque produit le
   * montant des ventes du mois moins `prix d'achat actuel × quantité vendue
   * du mois` (coût figé à la purge pour un produit supprimé). Les coûts des
   * autres mois n'interviennent plus (avant : coût de toutes les périodes
   * soustrait au montant du mois). Un coût inconnu PARMI LES VENTES DU MOIS
   * rend le gain inconnu (`null`). Même valeur que l'historique mensuel
   * exportable. Les écarts de stock figés à la purge (1-15D) ne sont pas
   * datés : ils restent dans la seule vue globale.
   */
  private async monthlyEstimatedProfit(
    organizationId: string,
    month: string,
    revenue: number,
  ): Promise<{ netProfit: number | null; avgMargin: number | null }> {
    const ranking = (await this.getProductsRanking(
      organizationId,
      month,
    )) as Array<{ netProfit: number | null }>;
    if (ranking.some((row) => row.netProfit === null)) {
      return { netProfit: null, avgMargin: null };
    }
    const gain = ranking.reduce((s, row) => s + row.netProfit!, 0);
    return {
      netProfit: gain,
      avgMargin: revenue > 0 ? (gain / revenue) * 100 : 0,
    };
  }

  /**
   * 1-15D — écarts figés à la purge (`PurgedStockAdjustment`) : là où le
   * stock d'un produit et ses ventes avaient divergé, la contribution de la
   * règle existante (stock) est conservée à l'identique.
   */
  private async purgedStockAdjustmentCost(
    organizationOid: Types.ObjectId,
  ): Promise<number> {
    const [row] = await this.stockAdjustmentModel.aggregate<{ cost: number }>([
      { $match: { organizationId: organizationOid } },
      {
        $group: {
          _id: null,
          cost: { $sum: { $multiply: ['$unitCost', '$units'] } },
        },
      },
    ]);
    return row?.cost ?? 0;
  }

  /**
   * 1-15D — coût des unités vendues de produits SUPPRIMÉS DÉFINITIVEMENT
   * (aucun document produit dans l'organisation), toutes périodes, comme le
   * coût des produits existants calculé par `getOverview`. Coût figé :
   * `lastKnownUnitCost` ; unités sans coût connu comptées à part.
   */
  private async purgedProductsCost(
    organizationOid: Types.ObjectId,
  ): Promise<{ cost: number; unknownCostUnits: number }> {
    const [row] = await this.saleModel.aggregate<{
      cost: number;
      unknownCostUnits: number;
    }>([
      { $match: { organizationId: organizationOid } },
      {
        $group: {
          _id: '$productId',
          cost: SALE_PURGED_COST,
          unknownCostUnits: SALE_UNKNOWN_COST_UNITS,
        },
      },
      {
        $lookup: {
          from: 'products',
          let: { productId: '$_id', organizationId: organizationOid },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$_id', '$$productId'] },
                    { $eq: ['$organizationId', '$$organizationId'] },
                  ],
                },
              },
            },
            { $project: { _id: 1 } },
          ],
          as: 'product',
        },
      },
      { $match: { product: { $size: 0 } } },
      {
        $group: {
          _id: null,
          cost: { $sum: '$cost' },
          unknownCostUnits: { $sum: '$unknownCostUnits' },
        },
      },
    ]);
    return {
      cost: row?.cost ?? 0,
      unknownCostUnits: row?.unknownCostUnits ?? 0,
    };
  }

  async getProductsRanking(organizationId: string, month?: string) {
    return this.rankingFor(
      new Types.ObjectId(organizationId),
      month ? this.monthMatch(month) : {},
    );
  }

  /**
   * Classement par produit sur un filtre de période quelconque (mois,
   * intervalle de comparaison 1-16E) : règle de gain inchangée.
   */
  private rankingFor(
    organizationOid: Types.ObjectId,
    periodMatch: Record<string, unknown>,
  ): Promise<ProductRankingRow[]> {
    const matchStage = { organizationId: organizationOid, ...periodMatch };
    return this.saleModel.aggregate<ProductRankingRow>([
      { $match: matchStage },
      {
        $group: {
          // 1-15D : regroupement par IDENTIFIANT, jamais par nom (deux
          // produits homonymes restent distincts, même après une purge).
          _id: '$productId',
          // Dernier nom figé à la purge (identique pour tout le groupe).
          lastKnownName: { $max: '$lastKnownProductName' },
          // Nom enregistré par la vente la plus récente (comparaison
          // `{ at, name }` : date d'abord ; ventes sans nom ignorées).
          latestRecorded: {
            $max: {
              $cond: [
                { $ifNull: ['$productName', false] },
                { at: '$createdAt', name: '$productName' },
                null,
              ],
            },
          },
          totalUnitsSold: { $sum: '$quantity' },
          totalRevenue: { $sum: { $multiply: ['$salePrice', '$quantity'] } },
          transactionCount: { $sum: 1 },
          purgedCost: SALE_PURGED_COST,
          unknownCostUnits: SALE_UNKNOWN_COST_UNITS,
        },
      },
      {
        $lookup: {
          from: 'products',
          let: { productId: '$_id', organizationId: organizationOid },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$_id', '$$productId'] },
                    { $eq: ['$organizationId', '$$organizationId'] },
                  ],
                },
              },
            },
          ],
          as: 'product',
        },
      },
      // preserveNullAndEmpty keeps groups whose product was permanently deleted
      { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          productDeleted: { $not: [{ $ifNull: ['$product._id', false] }] },
        },
      },
      {
        $addFields: {
          // Produit existant : règle inchangée (prix d'achat courant).
          // Produit supprimé : coût figé ; inconnu → `null`, jamais 0.
          netProfit: {
            $cond: [
              '$productDeleted',
              {
                $cond: [
                  { $gt: ['$unknownCostUnits', 0] },
                  null,
                  { $subtract: ['$totalRevenue', '$purgedCost'] },
                ],
              },
              {
                $subtract: [
                  '$totalRevenue',
                  { $multiply: ['$product.purchasePrice', '$totalUnitsSold'] },
                ],
              },
            ],
          },
        },
      },
      {
        $project: {
          productId: '$_id',
          productName: {
            $ifNull: [
              '$product.name',
              {
                $ifNull: [
                  '$lastKnownName',
                  { $ifNull: ['$latestRecorded.name', null] },
                ],
              },
            ],
          },
          productDeleted: 1,
          // R2 privé : aucune URL de photo ici (non affichée par l'Analyse ;
          // une photo n'est lisible que par URL signée à la lecture produit).
          // Stock courant : inexistant pour un produit supprimé (`null`).
          remainingQuantity: { $ifNull: ['$product.remainingQuantity', null] },
          totalUnitsSold: 1,
          totalRevenue: 1,
          netProfit: 1,
          transactionCount: 1,
        },
      },
      { $sort: { totalUnitsSold: -1 } },
    ]);
  }

  async getSellersRanking(organizationId: string, month?: string) {
    const matchStage = {
      organizationId: new Types.ObjectId(organizationId),
      ...(month ? this.monthMatch(month) : {}),
    };
    return this.saleModel.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$sellerId',
          totalUnitsSold: { $sum: '$quantity' },
          totalRevenue: { $sum: { $multiply: ['$salePrice', '$quantity'] } },
          transactionCount: { $sum: 1 },
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'seller',
        },
      },
      { $unwind: '$seller' },
      {
        $project: {
          sellerId: '$_id',
          sellerName: '$seller.name',
          sellerEmail: '$seller.email',
          totalUnitsSold: 1,
          totalRevenue: 1,
          transactionCount: 1,
        },
      },
      { $sort: { totalRevenue: -1 } },
    ]);
  }

  async getMonthlyTrend(organizationId: string) {
    const timezone = processTimeZone();
    return this.saleModel.aggregate([
      { $match: { organizationId: new Types.ObjectId(organizationId) } },
      {
        $group: {
          _id: {
            // 1-16D : même fuseau que les bornes de `monthMatch` (fuseau du
            // processus API) ; auparavant UTC, d'où un mois de la courbe et
            // de la liste des mois différent des filtres hors UTC.
            year: { $year: { date: SALE_EFFECTIVE_DATE, timezone } },
            month: { $month: { date: SALE_EFFECTIVE_DATE, timezone } },
          },
          totalRevenue: { $sum: { $multiply: ['$salePrice', '$quantity'] } },
          totalUnitsSold: { $sum: '$quantity' },
          transactionCount: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      {
        $project: {
          _id: 0,
          period: {
            $concat: [
              { $toString: '$_id.year' },
              '-',
              {
                $cond: [
                  { $lt: ['$_id.month', 10] },
                  { $concat: ['0', { $toString: '$_id.month' }] },
                  { $toString: '$_id.month' },
                ],
              },
            ],
          },
          totalRevenue: 1,
          totalUnitsSold: 1,
          transactionCount: 1,
        },
      },
    ]);
  }

  /**
   * 1-16E — aide à la décision de la page Analyse, calculée sur TOUTES les
   * ventes et TOUS les produits disponibles de l'organisation (aucune page) :
   *
   * - « Vos ventes » : totaux du mois choisi (mois en cours par défaut),
   *   issus du classement par produit (`rankingFor`) : même gain estimé que
   *   `getOverview(month)` et que l'historique mensuel exportable ;
   * - comparaison avec une période comparable (`comparisonWindow`) ;
   * - évolution jour par jour du mois et cinq premiers produits ;
   * - stock ACTUEL (indépendant du mois choisi) : listes à priorité unique
   *   (`decisionLists`), dont seule la première page est renvoyée ici ; la
   *   suite se lit par `getInsightList` ;
   * - « Prix à vérifier » et gains : uniquement avec le droit financier (sinon
   *   absents, ni décompte ni carte).
   *
   * Ventes enregistrées sur le serveur uniquement (modifications et
   * annulations déjà appliquées : une vente annulée n'existe plus).
   */
  async getInsights(
    organizationId: string,
    rights: InsightRights,
    month?: string,
    now: Date = new Date(),
  ) {
    const t = INSIGHT_THRESHOLDS;
    const orgOid = new Types.ObjectId(organizationId);
    const currentMonth = localMonthKey(now);
    const period = month ?? currentMonth;
    const bounds = monthBounds(period);
    const inProgress = now >= bounds.start && now < bounds.end;

    const organizationCreatedAt = await this.organizationCreatedAt(orgOid);
    const comparison = comparisonWindow(period, now, organizationCreatedAt);
    const window = observationWindow(now, t.observationWindowDays);

    const [ranking, previousRanking, daily, productDays, products] =
      await Promise.all([
        this.rankingFor(orgOid, saleMonthMatch(period)),
        comparison.available
          ? this.rankingFor(
              orgOid,
              saleRangeMatch(comparison.start, comparison.end),
            )
          : Promise.resolve(null),
        this.dailyTotals(orgOid, bounds.start, bounds.end),
        this.productDays(orgOid, window.start, window.end),
        this.availableProducts(orgOid),
      ]);

    const totals = (rows: readonly ProductRankingRow[]): PeriodTotals => {
      const base = {
        revenue: rows.reduce((s, r) => s + r.totalRevenue, 0),
        salesCount: rows.reduce((s, r) => s + r.transactionCount, 0),
        unitsSold: rows.reduce((s, r) => s + r.totalUnitsSold, 0),
      };
      if (!rights.financials) return base;
      // Un coût inconnu parmi les ventes de la période rend le gain inconnu.
      const gain = rows.some((r) => r.netProfit === null)
        ? null
        : rows.reduce((s, r) => s + (r.netProfit ?? 0), 0);
      return { ...base, gain };
    };

    // Évolution jour par jour : jours sans vente à zéro, jusqu'à aujourd'hui.
    const dailyByDay = new Map(daily.map((row) => [row.day, row]));
    const trendEnd = inProgress ? addLocalDays(now, 1) : bounds.end;
    const trend: Array<{ date: string; revenue: number; salesCount: number }> =
      [];
    for (let day = bounds.start; day < trendEnd; day = addLocalDays(day, 1)) {
      const key = localDayKey(day);
      const row = dailyByDay.get(key);
      trend.push({
        date: key,
        revenue: row?.revenue ?? 0,
        salesCount: row?.salesCount ?? 0,
      });
    }

    const topProducts = [...ranking]
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, t.topProducts)
      .map((r) => ({
        productId: String(r.productId),
        name: r.productName,
        productDeleted: r.productDeleted,
        revenue: r.totalRevenue,
        unitsSold: r.totalUnitsSold,
        // Stock ACTUEL (jamais historique) ; `null` : produit supprimé.
        remainingQuantity: r.remainingQuantity,
      }));

    const lists = this.decisionLists(
      products,
      productDays,
      window,
      organizationCreatedAt,
      ranking,
      rights,
    );
    const firstPage = <T>(items: T[]) => pageOf(items, 0, t.listLimit);
    const priorities = buildPriorities<InsightStockItem | InsightPriceItem>({
      out: lists.out,
      soon: lists.soon,
      ...(lists.price ? { price: lists.price } : {}),
      low: lists.low,
      stale: lists.stale,
    });

    const summary = totals(ranking);
    const previous = previousRanking ? totals(previousRanking) : null;
    return {
      generatedAt: now.toISOString(),
      timeZone: processTimeZone(),
      rights: { financials: rights.financials },
      thresholds: {
        observationWindowDays: t.observationWindowDays,
        minObservationDays: t.minObservationDays,
        minDistinctSaleDays: t.minDistinctSaleDays,
        soonStockoutDays: t.soonStockoutDays,
        listPageSize: t.listLimit,
      },
      period: {
        month: period,
        start: bounds.start.toISOString(),
        end: bounds.end.toISOString(),
        inProgress,
        isCurrentMonth: period === currentMonth,
      },
      summary,
      comparison:
        comparison.available && previous
          ? {
              available: true as const,
              partial: comparison.partial,
              month: comparison.month ?? null,
              start: comparison.start.toISOString(),
              end: comparison.end.toISOString(),
              totals: previous,
              revenueChange: changePercent(summary.revenue, previous.revenue),
              salesCountChange: changePercent(
                summary.salesCount,
                previous.salesCount,
              ),
              ...(comparison.partial
                ? {}
                : this.closedMonthRates(bounds, comparison, summary, previous)),
            }
          : {
              available: false as const,
              reason: comparison.available ? null : comparison.reason,
              start: comparison.start.toISOString(),
              end: comparison.end.toISOString(),
            },
      trend,
      topProducts,
      priorities,
      stock: {
        window: {
          start: window.start.toISOString(),
          end: window.end.toISOString(),
          days: window.days,
        },
        out: firstPage(lists.out),
        soon: firstPage(lists.soon),
        low: firstPage(lists.low),
        stale: firstPage(lists.stale),
        recent: firstPage(lists.recent),
      },
      ...(lists.price ? { priceChecks: firstPage(lists.price) } : {}),
    };
  }

  /**
   * 1-16E — deux mois TERMINÉS : durées réelles et rythme par jour. Les
   * totaux mensuels restent ceux des exports ; un mois de 31 jours au même
   * rythme qu'un mois de 28 jours a un total plus élevé, pas un rythme plus
   * élevé. Base précédente à zéro : aucun pourcentage (`changePercent`).
   */
  private closedMonthRates(
    bounds: { start: Date; end: Date },
    previousPeriod: { start: Date; end: Date },
    summary: PeriodTotals,
    previous: PeriodTotals,
  ) {
    const days = civilDaysBetween(bounds.start, bounds.end);
    const previousDays = civilDaysBetween(
      previousPeriod.start,
      previousPeriod.end,
    );
    return {
      days,
      previousDays,
      revenuePerDayChange: changePercent(
        summary.revenue / days,
        previous.revenue / previousDays,
      ),
      salesCountPerDayChange: changePercent(
        summary.salesCount / days,
        previous.salesCount / previousDays,
      ),
    };
  }

  /**
   * 1-16E — page d'une liste « Stock actuel » (`offset`, `limit`), dans le
   * même ordre stable et avec la même priorité unique que `getInsights`. Les
   * listes sont recalculées sur l'état courant : `count` est le total réel
   * au moment de la lecture. `price` n'existe qu'avec le droit financier
   * (refus du contrôleur avant tout calcul).
   */
  async getInsightList(
    organizationId: string,
    rights: InsightRights,
    kind: InsightListKind,
    page: { offset: number; limit: number },
    month?: string,
    now: Date = new Date(),
  ) {
    const orgOid = new Types.ObjectId(organizationId);
    const period = month ?? localMonthKey(now);
    const window = observationWindow(
      now,
      INSIGHT_THRESHOLDS.observationWindowDays,
    );
    const organizationCreatedAt = await this.organizationCreatedAt(orgOid);
    const [ranking, productDays, products] = await Promise.all([
      // Le classement de la période n'intervient que par le droit financier
      // (« Prix à vérifier » et priorité unique qui en dépend).
      rights.financials
        ? this.rankingFor(orgOid, saleMonthMatch(period))
        : Promise.resolve([] as ProductRankingRow[]),
      this.productDays(orgOid, window.start, window.end),
      this.availableProducts(orgOid),
    ]);
    const lists = this.decisionLists(
      products,
      productDays,
      window,
      organizationCreatedAt,
      ranking,
      rights,
    );
    const items: Array<InsightStockItem | InsightPriceItem> =
      (kind === 'price' ? lists.price : lists[kind]) ?? [];
    return { kind, month: period, ...pageOf(items, page.offset, page.limit) };
  }

  private async organizationCreatedAt(
    organizationOid: Types.ObjectId,
  ): Promise<Date | null> {
    const organization = await this.organizationModel
      .findById(organizationOid)
      .select({ createdAt: 1 })
      .lean<{ createdAt?: Date }>()
      .exec();
    return organization?.createdAt ?? null;
  }

  /** Produits DISPONIBLES (hors corbeille), champs utiles seulement. */
  private availableProducts(organizationOid: Types.ObjectId) {
    return this.productModel
      .find({ organizationId: organizationOid, deletedAt: null })
      .select({
        name: 1,
        sectionId: 1,
        remainingQuantity: 1,
        initialQuantity: 1,
        purchasePrice: 1,
        createdAt: 1,
      })
      .lean<InsightProductSource[]>()
      .exec();
  }

  /**
   * 1-16E — listes de décision, triées (ordre total et stable : critère
   * métier, puis nom, puis identifiant) et à PRIORITÉ UNIQUE
   * (`assignPrimaryPriority`) : un produit en rupture et vendu à perte ne
   * figure que dans « Rupture ». « Ajoutés récemment » exclut tout produit
   * déjà présent dans une liste prioritaire.
   */
  private decisionLists(
    products: readonly InsightProductSource[],
    productDays: readonly ProductDayRow[],
    window: { start: Date; end: Date },
    organizationCreatedAt: Date | null,
    ranking: readonly ProductRankingRow[],
    rights: InsightRights,
  ) {
    const stock = this.classifyProducts(
      products,
      productDays,
      window,
      organizationCreatedAt,
    );
    // « Prix à vérifier » : gain estimé NÉGATIF sur la période (coût connu),
    // produits disponibles seulement. Jamais calculé sans droit financier.
    let price: InsightPriceItem[] | undefined;
    if (rights.financials) {
      const productById = new Map(products.map((p) => [String(p._id), p]));
      price = ranking
        .filter(
          (r) => !r.productDeleted && r.netProfit !== null && r.netProfit < 0,
        )
        .flatMap((r) => {
          const p = productById.get(String(r.productId));
          if (!p) return [];
          return [
            {
              productId: String(r.productId),
              name: p.name,
              sectionId: String(p.sectionId),
              revenue: r.totalRevenue,
              unitsSold: r.totalUnitsSold,
              purchasePrice: p.purchasePrice,
              gain: r.netProfit as number,
            },
          ];
        })
        .sort((a, b) => a.gain - b.gain || stableOrder(a, b));
    }
    const primary = assignPrimaryPriority<InsightStockItem | InsightPriceItem>({
      out: stock.out,
      soon: stock.soon,
      ...(price ? { price } : {}),
      low: stock.low,
      stale: stock.stale,
    });
    const assigned = new Set(
      Object.values(primary).flatMap((list) => list.map((i) => i.productId)),
    );
    return {
      out: (primary.out ?? []) as InsightStockItem[],
      soon: (primary.soon ?? []) as InsightStockItem[],
      price: price ? ((primary.price ?? []) as InsightPriceItem[]) : undefined,
      low: (primary.low ?? []) as InsightStockItem[],
      stale: (primary.stale ?? []) as InsightStockItem[],
      recent: stock.recent.filter((i) => !assigned.has(i.productId)),
    };
  }

  /**
   * 1-16E — classe chaque produit DISPONIBLE selon son stock actuel et le
   * rythme de ses ventes sur la fenêtre (listes triées par urgence).
   */
  private classifyProducts(
    products: readonly InsightProductSource[],
    productDays: readonly ProductDayRow[],
    window: { start: Date; end: Date },
    organizationCreatedAt: Date | null,
  ) {
    const daysByProduct = new Map<string, ProductDayRow[]>();
    for (const row of productDays) {
      const rows = daysByProduct.get(row.productId) ?? [];
      rows.push(row);
      daysByProduct.set(row.productId, rows);
    }
    const out: InsightStockItem[] = [];
    const soon: InsightStockItem[] = [];
    const low: InsightStockItem[] = [];
    const stale: InsightStockItem[] = [];
    const recent: Array<InsightStockItem & { createdAt: number }> = [];
    for (const p of products) {
      const productId = String(p._id);
      const rows = daysByProduct.get(productId) ?? [];
      const estimate = estimateSalesRate({
        remainingQuantity: p.remainingQuantity,
        window,
        productCreatedAt: p.createdAt,
        organizationCreatedAt,
        days: rows,
      });
      const item: InsightStockItem = {
        productId,
        name: p.name,
        sectionId: String(p.sectionId),
        remainingQuantity: p.remainingQuantity,
        estimate,
      };
      const signal = classifyStock(p, estimate);
      if (signal === 'out') out.push(item);
      else if (signal === 'soon') soon.push(item);
      else if (signal === 'low') low.push(item);
      const kind = noRecentSaleKind({
        remainingQuantity: p.remainingQuantity,
        productCreatedAt: p.createdAt,
        windowStart: window.start,
        salesInWindow: rows.reduce((s, r) => s + r.units + r.invalid, 0),
      });
      if (kind === 'stale') stale.push(item);
      else if (kind === 'recent') {
        recent.push({ ...item, createdAt: p.createdAt?.getTime() ?? 0 });
      }
    }
    const daysLeft = (item: InsightStockItem) =>
      item.estimate.estimable ? (item.estimate.daysLeft ?? Infinity) : Infinity;
    out.sort(
      (a, b) =>
        b.estimate.unitsSold - a.estimate.unitsSold || stableOrder(a, b),
    );
    soon.sort((a, b) => daysLeft(a) - daysLeft(b) || stableOrder(a, b));
    low.sort(
      (a, b) => a.remainingQuantity - b.remainingQuantity || stableOrder(a, b),
    );
    stale.sort(
      (a, b) => b.remainingQuantity - a.remainingQuantity || stableOrder(a, b),
    );
    recent.sort((a, b) => b.createdAt - a.createdAt || stableOrder(a, b));
    return {
      out,
      soon,
      low,
      stale,
      recent: recent.map((r): InsightStockItem => ({
        productId: r.productId,
        name: r.name,
        sectionId: r.sectionId,
        remainingQuantity: r.remainingQuantity,
        estimate: r.estimate,
      })),
    };
  }

  /** 1-16E — montant et nombre de ventes par jour civil (fuseau API). */
  private dailyTotals(organizationOid: Types.ObjectId, start: Date, end: Date) {
    const timezone = processTimeZone();
    return this.saleModel.aggregate<{
      day: string;
      revenue: number;
      salesCount: number;
    }>([
      {
        $match: {
          organizationId: organizationOid,
          ...saleRangeMatch(start, end),
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: SALE_EFFECTIVE_DATE,
              timezone,
            },
          },
          revenue: { $sum: { $multiply: ['$salePrice', '$quantity'] } },
          salesCount: { $sum: 1 },
        },
      },
      { $project: { _id: 0, day: '$_id', revenue: 1, salesCount: 1 } },
    ]);
  }

  /**
   * 1-16E — ventes par produit et par jour civil sur la fenêtre
   * d'observation : quantités valides (nombre > 0) et ventes invalides
   * comptées à part (aucune estimation dans ce cas).
   */
  private productDays(
    organizationOid: Types.ObjectId,
    start: Date,
    end: Date,
  ): Promise<ProductDayRow[]> {
    const timezone = processTimeZone();
    const valid = {
      $and: [{ $isNumber: '$quantity' }, { $gt: ['$quantity', 0] }],
    };
    return this.saleModel.aggregate<ProductDayRow>([
      {
        $match: {
          organizationId: organizationOid,
          ...saleRangeMatch(start, end),
        },
      },
      {
        $group: {
          _id: {
            productId: '$productId',
            day: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: SALE_EFFECTIVE_DATE,
                timezone,
              },
            },
          },
          units: { $sum: { $cond: [valid, '$quantity', 0] } },
          invalid: { $sum: { $cond: [valid, 0, 1] } },
        },
      },
      {
        $project: {
          _id: 0,
          productId: { $toString: '$_id.productId' },
          day: '$_id.day',
          units: 1,
          invalid: 1,
        },
      },
    ]);
  }

  // 1-11C.1 : période sur `occurredAt` ; les ventes antérieures (sans
  // `occurredAt`, `null` couvre aussi « absent ») retombent sur `createdAt`.
  // 1-16D : logique déplacée telle quelle dans `month-range.ts`, partagée
  // avec l'historique mensuel exportable.
  private monthMatch(month: string): Record<string, unknown> {
    return saleMonthMatch(month);
  }
}
