import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Sale, SaleDocument } from '../sales/schemas/sale.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectModel(Sale.name) private saleModel: Model<SaleDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
  ) {}

  async getOverview(month?: string) {
    const matchStage = month ? this.monthMatch(month) : {};

    const [salesAgg, products] = await Promise.all([
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
      this.productModel.find().exec(),
    ]);

    const totalInvested = products.reduce(
      (s, p) => s + p.purchasePrice * p.initialQuantity,
      0,
    );
    const revenue = salesAgg[0]?.totalRevenue ?? 0;
    const unitsSold = salesAgg[0]?.totalUnitsSold ?? 0;
    const transactions = salesAgg[0]?.totalTransactions ?? 0;

    // Weighted avg cost of goods sold
    const totalCOGS = products.reduce((s, p) => {
      const sold = p.initialQuantity - p.remainingQuantity;
      return s + p.purchasePrice * sold;
    }, 0);

    return {
      totalInvested,
      totalRevenue: revenue,
      netProfit: revenue - totalCOGS,
      avgMargin: revenue > 0 ? ((revenue - totalCOGS) / revenue) * 100 : 0,
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

  async getProductsRanking(month?: string) {
    const matchStage = month ? this.monthMatch(month) : {};
    return this.saleModel.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$productId',
          // capture name snapshot so deleted products are still labelled
          productNameSnapshot: { $first: '$productName' },
          totalUnitsSold: { $sum: '$quantity' },
          totalRevenue: { $sum: { $multiply: ['$salePrice', '$quantity'] } },
          transactionCount: { $sum: 1 },
        },
      },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'product',
        },
      },
      // preserveNullAndEmpty keeps groups whose product was permanently deleted
      { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          totalCOGS: {
            $multiply: [
              { $ifNull: ['$product.purchasePrice', 0] },
              '$totalUnitsSold',
            ],
          },
          netProfit: {
            $subtract: [
              '$totalRevenue',
              {
                $multiply: [
                  { $ifNull: ['$product.purchasePrice', 0] },
                  '$totalUnitsSold',
                ],
              },
            ],
          },
        },
      },
      {
        $project: {
          productId: '$_id',
          productName: { $ifNull: ['$product.name', '$productNameSnapshot'] },
          imageUrl: { $ifNull: ['$product.imageUrl', null] },
          remainingQuantity: { $ifNull: ['$product.remainingQuantity', 0] },
          totalUnitsSold: 1,
          totalRevenue: 1,
          netProfit: 1,
          transactionCount: 1,
        },
      },
      { $sort: { totalUnitsSold: -1 } },
    ]);
  }

  async getSellersRanking(month?: string) {
    const matchStage = month ? this.monthMatch(month) : {};
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

  async getMonthlyTrend() {
    return this.saleModel.aggregate([
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
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

  private monthMatch(month: string): Record<string, unknown> {
    const [year, m] = month.split('-').map(Number);
    const start = new Date(year, m - 1, 1);
    const end = new Date(year, m, 1);
    return { createdAt: { $gte: start, $lt: end } };
  }
}
