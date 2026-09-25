import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { AnalyticsService } from './analytics.service';
import { Sale } from '../sales/schemas/sale.schema';
import { Product } from '../products/schemas/product.schema';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';

describe('AnalyticsService — isolation tenant (1-4D)', () => {
  let service: AnalyticsService;
  let saleModel: { aggregate: jest.Mock };
  let productModel: { find: jest.Mock };

  beforeEach(async () => {
    saleModel = { aggregate: jest.fn().mockResolvedValue([]) };
    productModel = {
      find: jest.fn(() => ({ exec: jest.fn().mockResolvedValue([]) })),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: getModelToken(Sale.name), useValue: saleModel },
        { provide: getModelToken(Product.name), useValue: productModel },
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
    expect((pipeline[0].$match as Record<string, unknown>).createdAt).toEqual({
      $gte: new Date(2026, 8, 1),
      $lt: new Date(2026, 9, 1),
    });
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
});
