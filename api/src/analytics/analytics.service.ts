import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale, SaleDocument } from '../sales/schemas/sale.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import {
  PurgedStockAdjustment,
  PurgedStockAdjustmentDocument,
} from '../products/schemas/purged-stock-adjustment.schema';

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

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectModel(Sale.name) private saleModel: Model<SaleDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(PurgedStockAdjustment.name)
    private stockAdjustmentModel: Model<PurgedStockAdjustmentDocument>,
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
    const revenue = salesAgg[0]?.totalRevenue ?? 0;
    const unitsSold = salesAgg[0]?.totalUnitsSold ?? 0;
    const transactions = salesAgg[0]?.totalTransactions ?? 0;

    // Weighted avg cost of goods sold
    // 1-15D : les unités vendues de produits supprimés définitivement gardent
    // le coût figé à la purge (même valeur qu'avant la suppression). Si l'un
    // de ces coûts est inconnu (purge antérieure, non rattrapée), le bénéfice
    // est INCONNU (`null`), jamais calculé avec un coût nul.
    const totalCOGS =
      products.reduce((s, p) => {
        const sold = p.initialQuantity - p.remainingQuantity;
        return s + p.purchasePrice * sold;
      }, 0) +
      purged.cost +
      stockAdjustment;
    const profitKnown = purged.unknownCostUnits === 0;

    return {
      totalInvested,
      totalRevenue: revenue,
      netProfit: profitKnown ? revenue - totalCOGS : null,
      avgMargin: profitKnown
        ? revenue > 0
          ? ((revenue - totalCOGS) / revenue) * 100
          : 0
        : null,
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
    const organizationOid = new Types.ObjectId(organizationId);
    const matchStage = {
      organizationId: organizationOid,
      ...(month ? this.monthMatch(month) : {}),
    };
    return this.saleModel.aggregate([
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
          imageUrl: { $ifNull: ['$product.imageUrl', null] },
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
    return this.saleModel.aggregate([
      { $match: { organizationId: new Types.ObjectId(organizationId) } },
      {
        $group: {
          _id: {
            year: { $year: SALE_EFFECTIVE_DATE },
            month: { $month: SALE_EFFECTIVE_DATE },
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

  // 1-11C.1 : période sur `occurredAt` ; les ventes antérieures (sans
  // `occurredAt`, `null` couvre aussi « absent ») retombent sur `createdAt`.
  private monthMatch(month: string): Record<string, unknown> {
    const [year, m] = month.split('-').map(Number);
    const range = { $gte: new Date(year, m - 1, 1), $lt: new Date(year, m, 1) };
    return {
      $or: [{ occurredAt: range }, { occurredAt: null, createdAt: range }],
    };
  }
}
