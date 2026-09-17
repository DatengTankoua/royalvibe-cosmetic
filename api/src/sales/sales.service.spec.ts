import { BadRequestException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Sale } from './schemas/sale.schema';
import { SalesService } from './sales.service';
import { ProductsService } from '../products/products.service';
import { EventsGateway } from '../events/events.gateway';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';

const SALE_OBJECT_ID = 'a1b2c3d4e5f60718293a4b5c';
const PRODUCT_OBJECT_ID = '112233445566778899001122';
const SELLER_OBJECT_ID = '99887766554433221100aabb';

function makeProduct(remaining: number) {
  return {
    _id: new Types.ObjectId(PRODUCT_OBJECT_ID),
    name: 'Produit A',
    purchasePrice: 200,
    salePrice: 500,
    initialQuantity: 10,
    remainingQuantity: remaining,
  };
}

function makeSaleEntity(overrides: Record<string, unknown> = {}) {
  const entity: Record<string, unknown> = {
    _id: new Types.ObjectId(SALE_OBJECT_ID),
    productId: new Types.ObjectId(PRODUCT_OBJECT_ID),
    quantity: 4,
    salePrice: 500,
    ...overrides,
  };
  const build = () => {
    entity.populate = jest.fn(() => entity);
    entity.save = jest.fn(() => Promise.resolve(entity));
    entity.deleteOne = jest.fn(() => Promise.resolve(entity));
    return entity;
  };
  return build();
}

describe('SalesService (Mongoose model, stock service and audit mocked — no real database)', () => {
  let service: SalesService;
  let saleModel: { create: jest.Mock; findById: jest.Mock };
  let products: {
    findOne: jest.Mock;
    decrementStock: jest.Mock;
    adjustStock: jest.Mock;
  };
  let audit: { log: jest.Mock };
  let events: { emit: jest.Mock };

  beforeEach(async () => {
    saleModel = { create: jest.fn(), findById: jest.fn() };
    products = {
      findOne: jest.fn(),
      decrementStock: jest.fn().mockResolvedValue(undefined),
      adjustStock: jest.fn().mockResolvedValue(undefined),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    events = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SalesService,
        { provide: getModelToken(Sale.name), useValue: saleModel },
        { provide: ProductsService, useValue: products },
        { provide: EventsGateway, useValue: events },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(SalesService);
  });

  describe('create — money and stock', () => {
    it('persists the sale with the product name snapshot and the seller id, then decrements exactly that quantity', async () => {
      saleModel.create.mockResolvedValue(makeSaleEntity());
      products.findOne.mockResolvedValue({ product: makeProduct(8) });

      const result = await service.create(
        {
          productId: PRODUCT_OBJECT_ID,
          quantity: 3,
          salePrice: 500,
          buyerName: 'Bob',
        },
        SELLER_OBJECT_ID,
      );

      const call = saleModel.create.mock.calls[0][0] as Record<string, unknown>;
      expect(call.quantity).toBe(3);
      expect(call.salePrice).toBe(500);
      expect(call.productName).toBe('Produit A');
      expect(call.sellerId).toEqual(new Types.ObjectId(SELLER_OBJECT_ID));
      expect(products.decrementStock).toHaveBeenCalledWith(
        PRODUCT_OBJECT_ID,
        3,
      );
      expect(events.emit).toHaveBeenCalledWith(
        'sale:created',
        expect.anything(),
      );
      expect(result).toEqual(expect.objectContaining({ quantity: 4 }));
    });

    it('documents the sale amount as quantity × salePrice', async () => {
      saleModel.create.mockResolvedValue(
        makeSaleEntity({ quantity: 4, salePrice: 450 }),
      );
      products.findOne.mockResolvedValue({ product: makeProduct(8) });

      const result = await service.create(
        { productId: PRODUCT_OBJECT_ID, quantity: 4, salePrice: 450 },
        SELLER_OBJECT_ID,
      );

      expect(Number(result.quantity) * Number(result.salePrice)).toBe(1800);
    });

    it('refuses to create a sale when stock is insufficient, without stock or audit side effects', async () => {
      saleModel.create.mockResolvedValue(makeSaleEntity());
      products.findOne.mockResolvedValue({ product: makeProduct(2) });

      await expect(
        service.create(
          { productId: PRODUCT_OBJECT_ID, quantity: 3, salePrice: 500 },
          SELLER_OBJECT_ID,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(saleModel.create).not.toHaveBeenCalled();
      expect(products.decrementStock).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('create — audit history', () => {
    it('writes a SOLD audit entry with the seller as actor and the expected details', async () => {
      saleModel.create.mockResolvedValue(makeSaleEntity());
      products.findOne.mockResolvedValue({ product: makeProduct(9) });

      await service.create(
        {
          productId: PRODUCT_OBJECT_ID,
          quantity: 1,
          salePrice: 500,
          buyerName: 'Bob',
        },
        SELLER_OBJECT_ID,
      );

      expect(audit.log).toHaveBeenCalledTimes(1);
      const [productId, action, actorId, details] = audit.log.mock
        .calls[0] as unknown as [
        Types.ObjectId,
        AuditAction,
        string,
        Record<string, unknown>,
      ];
      // SalesService passes productId.toString() to the audit service:
      // the compared value must be the product id itself. (toEqual on
      // two different ObjectId classes would be a false failure.)
      expect(productId.toString()).toBe(PRODUCT_OBJECT_ID);
      expect(action).toBe(AuditAction.SOLD);
      expect(actorId).toBe(SELLER_OBJECT_ID);
      expect(details).toEqual(
        expect.objectContaining({
          quantity: 1,
          salePrice: 500,
          buyerName: 'Bob',
        }),
      );
    });
  });

  describe('update — stock adjustment mirrors the quantity change', () => {
    it('lowering the quantity restores stock by the delta (old − new)', async () => {
      const entity = makeSaleEntity();
      saleModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(entity),
      });

      await service.update(SALE_OBJECT_ID, { quantity: 2 }, 'actor-1');

      expect(products.adjustStock).toHaveBeenCalledWith(PRODUCT_OBJECT_ID, 2);
      expect(entity.quantity as number).toBe(2);
      expect(audit.log).toHaveBeenCalledWith(
        PRODUCT_OBJECT_ID,
        AuditAction.SALE_UPDATED,
        'actor-1',
        expect.objectContaining({
          saleId: SALE_OBJECT_ID,
          quantity: { from: 4, to: 2 },
        }),
      );
    });

    it('raising the quantity consumes additional stock (negative delta)', async () => {
      const entity = makeSaleEntity({ quantity: 2 });
      saleModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(entity),
      });

      await service.update(SALE_OBJECT_ID, { quantity: 5 }, 'actor-1');

      expect(products.adjustStock).toHaveBeenCalledWith(PRODUCT_OBJECT_ID, -3);
    });

    it('a price-only change does not touch stock', async () => {
      const entity = makeSaleEntity();
      saleModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(entity),
      });

      await service.update(SALE_OBJECT_ID, { salePrice: 480 }, 'actor-1');

      expect(products.adjustStock).not.toHaveBeenCalled();
      expect(entity.salePrice as number).toBe(480);
    });
  });

  describe('remove — cancellation restores stock and is audited', () => {
    it('restores the full quantity to stock and logs SALE_CANCELLED', async () => {
      const entity = makeSaleEntity({ quantity: 3, salePrice: 500 });
      saleModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(entity),
      });

      await service.remove(SALE_OBJECT_ID, 'actor-1');

      expect(products.adjustStock).toHaveBeenCalledWith(PRODUCT_OBJECT_ID, 3);
      expect(entity.deleteOne).toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        PRODUCT_OBJECT_ID,
        AuditAction.SALE_CANCELLED,
        'actor-1',
        expect.objectContaining({
          saleId: SALE_OBJECT_ID,
          quantity: 3,
          salePrice: 500,
        }),
      );
    });
  });
});
