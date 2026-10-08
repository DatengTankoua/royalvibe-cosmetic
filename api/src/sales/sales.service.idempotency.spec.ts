import { ConflictException } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Sale } from './schemas/sale.schema';
import { SaleOperation } from './schemas/sale-operation.schema';
import { SalesService } from './sales.service';
import { ProductsService } from '../products/products.service';
import { EventsGateway } from '../events/events.gateway';
import { AuditService } from '../audit/audit.service';
import { SALE_ERROR_CODES } from './sale-error-codes';
import {
  computeSaleRequestHash,
  normalizeCreateSale,
} from './sale-idempotency';
import type { CreateSaleDto } from './dto/create-sale.dto';

/**
 * 1-11C.1 — Idempotence de `SalesService.create` (sans base réelle).
 */

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const SELLER = '99887766554433221100aabb';
const OTHER_SELLER = '99887766554433221100ccdd';
const PRODUCT = '112233445566778899001122';
const SALE_ID = 'a1b2c3d4e5f60718293a4b5c';
const KEY = '3b241101-e2bb-4255-8caf-4136c566a962';

const dto: CreateSaleDto = {
  productId: PRODUCT,
  quantity: 2,
  salePrice: 500,
  buyerName: 'Bob',
  clientOperationId: KEY,
};
const HASH = computeSaleRequestHash(normalizeCreateSale(dto));

function chain(result: unknown) {
  const c = {
    read: jest.fn(() => c),
    populate: jest.fn(() => c),
    exec: jest.fn().mockResolvedValue(result),
  };
  return c;
}

function operation(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: new Types.ObjectId(ORG_A),
    clientOperationId: KEY,
    sellerId: new Types.ObjectId(SELLER),
    saleId: new Types.ObjectId(SALE_ID),
    requestHash: HASH,
    ...overrides,
  };
}

function duplicateKeyError(keyPattern: Record<string, number>) {
  return Object.assign(new Error('E11000 duplicate key error'), {
    code: 11000,
    keyPattern,
  });
}

const code = (e: unknown) =>
  ((e as ConflictException).getResponse() as { code?: string }).code;

describe('SalesService — idempotence (1-11C.1)', () => {
  let service: SalesService;
  let saleModel: { create: jest.Mock; findOne: jest.Mock };
  let operationModel: { create: jest.Mock; findOne: jest.Mock };
  let products: { decrementStock: jest.Mock };
  let audit: { log: jest.Mock };
  let events: { emitToOrganization: jest.Mock };
  let session: { withTransaction: jest.Mock; endSession: jest.Mock };
  let saleEntity: {
    _id: Types.ObjectId;
    $session: jest.Mock;
    populate: jest.Mock;
  };

  beforeEach(async () => {
    saleEntity = {
      _id: new Types.ObjectId(SALE_ID),
      $session: jest.fn(),
      populate: jest.fn(),
    };
    saleEntity.$session.mockReturnValue(saleEntity);
    saleEntity.populate.mockResolvedValue(saleEntity);
    session = {
      withTransaction: jest.fn(async (cb: (s: unknown) => Promise<unknown>) =>
        cb(session),
      ),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    saleModel = {
      create: jest.fn().mockResolvedValue([saleEntity]),
      findOne: jest.fn(),
    };
    operationModel = {
      create: jest.fn().mockResolvedValue([{}]),
      findOne: jest.fn().mockReturnValue(chain(null)),
    };
    products = {
      decrementStock: jest.fn().mockResolvedValue({ name: 'Produit A' }),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    events = { emitToOrganization: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SalesService,
        {
          provide: getConnectionToken(),
          useValue: { startSession: jest.fn().mockResolvedValue(session) },
        },
        { provide: getModelToken(Sale.name), useValue: saleModel },
        {
          provide: getModelToken(SaleOperation.name),
          useValue: operationModel,
        },
        { provide: ProductsService, useValue: products },
        { provide: EventsGateway, useValue: events },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(SalesService);
  });

  const expectNoSideEffect = () => {
    expect(session.withTransaction).not.toHaveBeenCalled();
    expect(products.decrementStock).not.toHaveBeenCalled();
    expect(saleModel.create).not.toHaveBeenCalled();
    expect(operationModel.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(events.emitToOrganization).not.toHaveBeenCalled();
  };

  describe('chemin neuf', () => {
    it('trace SaleOperation en PREMIÈRE écriture, même session, même saleId', async () => {
      await service.create(ORG_A, dto, SELLER);

      expect(operationModel.findOne).toHaveBeenCalledWith({
        organizationId: new Types.ObjectId(ORG_A),
        clientOperationId: KEY,
      });
      const [[opDoc], opOpts] = operationModel.create.mock.calls[0] as [
        Record<string, unknown>[],
        { session: unknown },
      ];
      expect(opOpts.session).toBe(session);
      expect(String(opDoc.organizationId)).toBe(ORG_A);
      expect(String(opDoc.sellerId)).toBe(SELLER);
      expect(opDoc.requestHash).toBe(HASH);
      expect(opDoc.clientOperationId).toBe(KEY);

      const [[saleDoc]] = saleModel.create.mock.calls[0] as [
        Record<string, unknown>[],
      ];
      expect(String(saleDoc._id)).toBe(String(opDoc.saleId));
      expect(saleDoc.occurredAt).toBeInstanceOf(Date);

      const opOrder = operationModel.create.mock.invocationCallOrder[0];
      expect(opOrder).toBeLessThan(
        products.decrementStock.mock.invocationCallOrder[0],
      );
      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log.mock.calls[0][4]).toEqual(
        expect.objectContaining({ clientOperationId: KEY }),
      );
      expect(events.emitToOrganization).toHaveBeenCalledTimes(1);
    });

    it('occurredAt fourni hors plage → 400 SALE_DATE_OUT_OF_RANGE, aucune écriture', async () => {
      const old = new Date(Date.now() - 15 * 24 * 3600 * 1000).toISOString();
      const err = await service
        .create(ORG_A, { ...dto, occurredAt: old }, SELLER)
        .catch((e: unknown) => e);
      expect(code(err)).toBe(SALE_ERROR_CODES.SALE_DATE_OUT_OF_RANGE);
      expectNoSideEffect();
    });

    it('échec d’émission Socket.IO après commit : la vente est tout de même renvoyée', async () => {
      events.emitToOrganization.mockImplementation(() => {
        throw new Error('socket down');
      });
      await expect(service.create(ORG_A, dto, SELLER)).resolves.toBe(
        saleEntity,
      );
    });
  });

  describe('rejeu (chemin rapide)', () => {
    it('nominal : renvoie la vente courante, sans stock/audit/événement', async () => {
      operationModel.findOne.mockReturnValue(chain(operation()));
      const saleChain = chain(saleEntity);
      saleModel.findOne.mockReturnValue(saleChain);

      await expect(service.create(ORG_A, dto, SELLER)).resolves.toBe(
        saleEntity,
      );
      expect(saleModel.findOne).toHaveBeenCalledWith({
        _id: new Types.ObjectId(SALE_ID),
        organizationId: new Types.ObjectId(ORG_A),
      });
      expect(saleChain.populate).toHaveBeenCalledWith('sellerId', 'name email');
      expectNoSideEffect();
    });

    it('rejeu tardif hors plage de date : aboutit quand même (clé déjà appliquée)', async () => {
      const old = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString();
      const lateDto = { ...dto, occurredAt: old };
      operationModel.findOne.mockReturnValue(
        chain(
          operation({
            requestHash: computeSaleRequestHash(normalizeCreateSale(lateDto)),
          }),
        ),
      );
      saleModel.findOne.mockReturnValue(chain(saleEntity));
      await expect(service.create(ORG_A, lateDto, SELLER)).resolves.toBe(
        saleEntity,
      );
      expectNoSideEffect();
    });

    it('autre vendeur → 409 IDEMPOTENCY_KEY_CONFLICT sans aucune donnée de vente', async () => {
      operationModel.findOne.mockReturnValue(chain(operation()));
      const err = await service
        .create(ORG_A, dto, OTHER_SELLER)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(code(err)).toBe(SALE_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT);
      const body = JSON.stringify((err as ConflictException).getResponse());
      expect(body).not.toContain(SALE_ID);
      expect(body).not.toContain(HASH);
      expect(saleModel.findOne).not.toHaveBeenCalled();
      expectNoSideEffect();
    });

    it('payload différent → 409 IDEMPOTENCY_KEY_REUSED', async () => {
      operationModel.findOne.mockReturnValue(chain(operation()));
      const err = await service
        .create(ORG_A, { ...dto, quantity: 3 }, SELLER)
        .catch((e: unknown) => e);
      expect(code(err)).toBe(SALE_ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
      expect(saleModel.findOne).not.toHaveBeenCalled();
      expectNoSideEffect();
    });

    it('vente supprimée depuis → 409 SALE_OPERATION_ALREADY_APPLIED', async () => {
      operationModel.findOne.mockReturnValue(chain(operation()));
      saleModel.findOne.mockReturnValue(chain(null));
      const err = await service
        .create(ORG_A, dto, SELLER)
        .catch((e: unknown) => e);
      expect(code(err)).toBe(SALE_ERROR_CODES.SALE_OPERATION_ALREADY_APPLIED);
      expectNoSideEffect();
    });
  });

  describe('E11000 concurrent', () => {
    it('E11000 de l’index idempotent → relecture primary puis rejeu, sans émission', async () => {
      const winnerChain = chain(operation());
      operationModel.findOne
        .mockReturnValueOnce(chain(null))
        .mockReturnValueOnce(winnerChain);
      operationModel.create.mockRejectedValue(
        duplicateKeyError({ organizationId: 1, clientOperationId: 1 }),
      );
      saleModel.findOne.mockReturnValue(chain(saleEntity));

      await expect(service.create(ORG_A, dto, SELLER)).resolves.toBe(
        saleEntity,
      );
      expect(winnerChain.read).toHaveBeenCalledWith('primary');
      expect(products.decrementStock).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(events.emitToOrganization).not.toHaveBeenCalled();
      expect(session.endSession).toHaveBeenCalledTimes(1);
    });

    it('autre E11000 → relancé tel quel, aucune relecture', async () => {
      const other = duplicateKeyError({ email: 1 });
      operationModel.create.mockRejectedValue(other);
      await expect(service.create(ORG_A, dto, SELLER)).rejects.toBe(other);
      expect(operationModel.findOne).toHaveBeenCalledTimes(1);
    });

    it('erreur non-E11000 → relancée', async () => {
      products.decrementStock.mockRejectedValue(new Error('boom'));
      await expect(service.create(ORG_A, dto, SELLER)).rejects.toThrow('boom');
      expect(operationModel.findOne).toHaveBeenCalledTimes(1);
      expect(events.emitToOrganization).not.toHaveBeenCalled();
    });
  });

  describe('flux sans clé (non-régression)', () => {
    it('aucune lecture/écriture SaleOperation, _id non imposé, occurredAt serveur', async () => {
      const { clientOperationId: _omit, ...legacy } = dto;
      void _omit;
      const before = Date.now();
      await service.create(ORG_A, legacy, SELLER);

      expect(operationModel.findOne).not.toHaveBeenCalled();
      expect(operationModel.create).not.toHaveBeenCalled();
      const [[saleDoc]] = saleModel.create.mock.calls[0] as [
        Record<string, unknown>[],
      ];
      expect(saleDoc._id).toBeUndefined();
      expect((saleDoc.occurredAt as Date).getTime()).toBeGreaterThanOrEqual(
        before,
      );
      expect(audit.log.mock.calls[0][4]).not.toHaveProperty(
        'clientOperationId',
      );
      expect(events.emitToOrganization).toHaveBeenCalledTimes(1);
    });

    it('occurredAt fourni sans clé est conservé tel quel', async () => {
      const at = new Date(Date.now() - 3600 * 1000);
      const { clientOperationId: _omit, ...legacy } = dto;
      void _omit;
      await service.create(
        ORG_A,
        { ...legacy, occurredAt: at.toISOString() },
        SELLER,
      );
      const [[saleDoc]] = saleModel.create.mock.calls[0] as [
        Record<string, unknown>[],
      ];
      expect((saleDoc.occurredAt as Date).toISOString()).toBe(at.toISOString());
    });
  });
});
