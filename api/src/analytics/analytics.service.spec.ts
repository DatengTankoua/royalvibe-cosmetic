import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { AnalyticsService } from './analytics.service';
import { processTimeZone } from './month-range';
import { Sale } from '../sales/schemas/sale.schema';
import { Product } from '../products/schemas/product.schema';
import { PurgedStockAdjustment } from '../products/schemas/purged-stock-adjustment.schema';
import { Organization } from '../organizations/schemas/organization.schema';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';

describe('AnalyticsService — isolation tenant (1-4D)', () => {
  let service: AnalyticsService;
  let saleModel: { aggregate: jest.Mock };
  let productModel: { find: jest.Mock };
  let stockAdjustmentModel: { aggregate: jest.Mock };

  beforeEach(async () => {
    saleModel = { aggregate: jest.fn().mockResolvedValue([]) };
    productModel = {
      find: jest.fn(() => ({ exec: jest.fn().mockResolvedValue([]) })),
    };
    stockAdjustmentModel = { aggregate: jest.fn().mockResolvedValue([]) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: getModelToken(Sale.name), useValue: saleModel },
        { provide: getModelToken(Product.name), useValue: productModel },
        {
          provide: getModelToken(PurgedStockAdjustment.name),
          useValue: stockAdjustmentModel,
        },
        { provide: getModelToken(Organization.name), useValue: {} },
      ],
    }).compile();
    service = module.get(AnalyticsService);
  });

  const expectTenantMatch = (pipeline: Record<string, unknown>[]) => {
    const match = pipeline[0].$match as Record<string, unknown>;
    expect(match.organizationId).toBeInstanceOf(Types.ObjectId);
    expect(String(match.organizationId)).toBe(ORG_A);
  };

  it('overview commence par le tenant + période et filtre les produits par tenant', async () => {
    await service.getOverview(ORG_A, '2026-09');

    const pipeline = saleModel.aggregate.mock.calls[0][0] as Record<
      string,
      unknown
    >[];
    expectTenantMatch(pipeline);
    // 1-11C.1 : période sur `occurredAt`, repli `createdAt` (ventes anciennes).
    const range = { $gte: new Date(2026, 8, 1), $lt: new Date(2026, 9, 1) };
    expect((pipeline[0].$match as Record<string, unknown>).$or).toEqual([
      { occurredAt: range },
      { occurredAt: null, createdAt: range },
    ]);
    expect(productModel.find).toHaveBeenCalledWith({
      organizationId: new Types.ObjectId(ORG_A),
    });
  });

  it('ranking produits commence par le tenant et le lookup vérifie aussi le tenant', async () => {
    await service.getProductsRanking(ORG_A);

    const pipeline = saleModel.aggregate.mock.calls[0][0] as Record<
      string,
      unknown
    >[];
    expectTenantMatch(pipeline);
    const lookup = pipeline.find((stage) => '$lookup' in stage)?.$lookup;
    expect(lookup).toEqual({
      from: 'products',
      let: {
        productId: '$_id',
        organizationId: new Types.ObjectId(ORG_A),
      },
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
    });
  });

  it('ranking vendeurs et tendance mensuelle commencent par le tenant', async () => {
    await service.getSellersRanking(ORG_A);
    await service.getMonthlyTrend(ORG_A);

    const sellerPipeline = saleModel.aggregate.mock.calls[0][0] as Record<
      string,
      unknown
    >[];
    const monthlyPipeline = saleModel.aggregate.mock.calls[1][0] as Record<
      string,
      unknown
    >[];
    expectTenantMatch(sellerPipeline);
    expectTenantMatch(monthlyPipeline);
  });

  it('tendance mensuelle groupe par occurredAt avec repli createdAt (1-11C.1), dans le fuseau des bornes (1-16D)', async () => {
    await service.getMonthlyTrend(ORG_A);
    const pipeline = saleModel.aggregate.mock.calls[0][0] as Record<
      string,
      unknown
    >[];
    const group = pipeline.find((stage) => '$group' in stage)?.$group as {
      _id: unknown;
    };
    const effective = { $ifNull: ['$occurredAt', '$createdAt'] };
    const timezone = processTimeZone();
    expect(group._id).toEqual({
      year: { $year: { date: effective, timezone } },
      month: { $month: { date: effective, timezone } },
    });
  });

  // ---- 1-15D : historique après suppression définitive ----

  const productDoc = (
    purchasePrice: number,
    initial: number,
    remaining: number,
  ) => ({
    purchasePrice,
    initialQuantity: initial,
    remainingQuantity: remaining,
  });

  it('1-15D overview : le coût figé des produits supprimés reste dans le bénéfice (tenant vérifié)', async () => {
    saleModel.aggregate
      .mockResolvedValueOnce([
        { totalRevenue: 1600, totalUnitsSold: 4, totalTransactions: 2 },
      ])
      .mockResolvedValueOnce([{ cost: 200, unknownCostUnits: 0 }]);
    productModel.find.mockReturnValue({
      exec: jest.fn().mockResolvedValue([productDoc(100, 10, 8)]),
    });

    const res = await service.getOverview(ORG_A);
    // 1600 − (100 × 2 existants + 200 figés) ; inventaire courant inchangé.
    expect(res.netProfit).toBe(1200);
    expect(res.avgMargin).toBe(75);
    expect(res.totalInvested).toBe(1000);
    expect(res.productsCount).toBe(1);

    const purgedPipeline = saleModel.aggregate.mock.calls[1][0] as Record<
      string,
      unknown
    >[];
    expectTenantMatch(purgedPipeline);
    const lookup = purgedPipeline.find((stage) => '$lookup' in stage)
      ?.$lookup as { let: { organizationId: Types.ObjectId } };
    expect(String(lookup.let.organizationId)).toBe(ORG_A);
    expect(purgedPipeline).toContainEqual({
      $match: { product: { $size: 0 } },
    });
  });

  it('1-15D overview : coût inconnu → bénéfice et marge `null`, jamais calculés avec 0', async () => {
    saleModel.aggregate
      .mockResolvedValueOnce([
        { totalRevenue: 800, totalUnitsSold: 2, totalTransactions: 1 },
      ])
      .mockResolvedValueOnce([{ cost: 0, unknownCostUnits: 2 }]);
    const res = await service.getOverview(ORG_A);
    expect(res.totalRevenue).toBe(800);
    expect(res.unitsSold).toBe(2);
    expect(res.netProfit).toBeNull();
    expect(res.avgMargin).toBeNull();
  });

  it('1-15D overview : sans vente de produit supprimé, résultat identique à la règle existante', async () => {
    saleModel.aggregate
      .mockResolvedValueOnce([
        { totalRevenue: 800, totalUnitsSold: 2, totalTransactions: 1 },
      ])
      .mockResolvedValueOnce([]);
    productModel.find.mockReturnValue({
      exec: jest.fn().mockResolvedValue([productDoc(100, 10, 8)]),
    });
    const res = await service.getOverview(ORG_A);
    expect(res.netProfit).toBe(600);
    expect(res.avgMargin).toBe(75);
  });

  it('1-15D ranking : groupé par identifiant ; supprimé → nom conservé, stock `null`, bénéfice figé ou `null`', async () => {
    await service.getProductsRanking(ORG_A);
    const pipeline = saleModel.aggregate.mock.calls[0][0] as Record<
      string,
      unknown
    >[];
    const group = pipeline.find((stage) => '$group' in stage)?.$group as Record<
      string,
      unknown
    >;
    expect(group._id).toBe('$productId');
    const project = pipeline.find((stage) => '$project' in stage)
      ?.$project as Record<string, unknown>;
    expect(project.productName).toEqual({
      $ifNull: [
        '$product.name',
        {
          $ifNull: [
            '$lastKnownName',
            { $ifNull: ['$latestRecorded.name', null] },
          ],
        },
      ],
    });
    expect(project.remainingQuantity).toEqual({
      $ifNull: ['$product.remainingQuantity', null],
    });
    expect(project.productDeleted).toBe(1);
    const profit = pipeline
      .filter((stage) => '$addFields' in stage)
      .map((stage) => stage.$addFields as Record<string, unknown>)
      .find((fields) => 'netProfit' in fields)?.netProfit;
    expect(profit).toEqual({
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
    });
    // Aucun 0 de substitution sur le prix d'achat.
    expect(JSON.stringify(pipeline)).not.toContain(
      '["$product.purchasePrice",0]',
    );
  });

  it('1-15D overview : écart figé à la purge ajouté au coût (règle de stock conservée), tenant vérifié', async () => {
    saleModel.aggregate
      .mockResolvedValueOnce([
        { totalRevenue: 2000, totalUnitsSold: 5, totalTransactions: 2 },
      ])
      .mockResolvedValueOnce([{ cost: 500, unknownCostUnits: 0 }]);
    stockAdjustmentModel.aggregate.mockResolvedValue([{ cost: -300 }]);
    const res = await service.getOverview(ORG_A);
    // 2000 − (500 − 300) : identique à 100 × (25 − 23) avant la purge.
    expect(res.netProfit).toBe(1800);
    const pipeline = stockAdjustmentModel.aggregate.mock.calls[0][0] as Record<
      string,
      unknown
    >[];
    expectTenantMatch(pipeline);
  });
});
