import { BadRequestException } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
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

function makeProduct(name = 'Produit A') {
  return {
    _id: new Types.ObjectId(PRODUCT_OBJECT_ID),
    name,
    purchasePrice: 200,
    salePrice: 500,
    initialQuantity: 10,
    remainingQuantity: 5,
    deletedAt: null,
  };
}

interface SaleEntityRecord {
  _id: unknown;
  productId: unknown;
  quantity: number;
  salePrice: number;
  save?: jest.Mock;
  deleteOne?: jest.Mock;
  $session: jest.Mock;
  populate: jest.Mock;
}

function makeSaleEntity(overrides: Record<string, unknown> = {}) {
  const entity = {
    _id: new Types.ObjectId(SALE_OBJECT_ID),
    productId: new Types.ObjectId(PRODUCT_OBJECT_ID),
    quantity: 4,
    salePrice: 500,
    ...overrides,
  } as SaleEntityRecord;
  // `$session(null)` (détachement de la session close) — API Mongoose réelle.
  entity.$session = jest.fn(() => entity);
  entity.populate = jest.fn(() => Promise.resolve(entity));
  return entity;
}

/**
 * Fabrique la « session transactionnelle » de test : une référence STABLE et
 * UNIQUE, renvoyée par `startSession()`. C'est cette référence exacte que les
 * assertions comparent (`toBe`) pour prouver que la même session est transmise
 * au stock, à la vente et à l'audit.
 *
 * `withTransaction` EXÉCUTE le callback avec la session (comportement du
 * driver) et propage tout rejet du callback — exactement ce que
 * Mongoose/driver font (commit si le callback résout, abort sinon) — mais
 * sans base réelle.
 */
function makeSessionFixture() {
  const endSession = jest.fn().mockResolvedValue(true);
  const abortTransaction = jest.fn();
  const commitTransaction = jest.fn();
  // `sessionRef` est créé AVANT le mock de `withTransaction` : le mock
  // référence directement la session unique, pour les assertions `toBe`.
  const withTransaction = jest.fn(
    async (cb: (s: unknown) => Promise<unknown>) => cb(sessionRef),
  );
  const sessionRef = {
    withTransaction,
    endSession,
    abortTransaction,
    commitTransaction,
  };
  const connection = {
    startSession: jest.fn(() => Promise.resolve(sessionRef)),
  };
  return { withTransaction, endSession, session: sessionRef, connection };
}

/** Récupère l'exception d'une promesse (undefined si elle résout). */
const thrown = async <T>(promise: Promise<unknown>): Promise<T> => {
  try {
    await promise;
    return undefined as unknown as T;
  } catch (e) {
    return e as T;
  }
};

describe('SalesService — transaction atomique vente–stock–audit (0B.7B)', () => {
  let service: SalesService;
  let saleModel: { create: jest.Mock; findById: jest.Mock };
  let products: {
    decrementStock: jest.Mock;
    adjustStock: jest.Mock;
    findOne: jest.Mock;
  };
  let audit: { log: jest.Mock };
  let events: { emit: jest.Mock };
  let fixture: ReturnType<typeof makeSessionFixture>;
  let saleEntity: SaleEntityRecord;

  beforeEach(async () => {
    fixture = makeSessionFixture();

    saleEntity = makeSaleEntity();
    // `create([doc], { session })` (overload tableau) résout un TABLEAU :
    saleModel = {
      create: jest.fn().mockResolvedValue([saleEntity]),
      findById: jest.fn(),
    };
    products = {
      // par défaut : décrémentation validée, renvoie le produit.
      decrementStock: jest.fn().mockResolvedValue(makeProduct()),
      adjustStock: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    events = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SalesService,
        { provide: getConnectionToken(), useValue: fixture.connection },
        { provide: getModelToken(Sale.name), useValue: saleModel },
        { provide: ProductsService, useValue: products },
        { provide: EventsGateway, useValue: events },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(SalesService);
  });

  const baseDto = {
    productId: PRODUCT_OBJECT_ID,
    quantity: 3,
    salePrice: 500,
    buyerName: 'Bob',
  };

  describe('cycle de vie de session', () => {
    it('startSession() est appelé sur la connexion injectée', async () => {
      await service.create(baseDto, SELLER_OBJECT_ID);
      expect(fixture.connection.startSession).toHaveBeenCalledTimes(1);
    });

    it('withTransaction() est utilisé pour encapsuler les écritures', async () => {
      await service.create(baseDto, SELLER_OBJECT_ID);
      expect(fixture.session.withTransaction).toHaveBeenCalledTimes(1);
      const cb = fixture.session.withTransaction.mock.calls[0][0] as unknown;
      expect(typeof cb).toBe('function');
    });

    it('endSession() est exécuté sur succès', async () => {
      await service.create(baseDto, SELLER_OBJECT_ID);
      expect(fixture.session.endSession).toHaveBeenCalledTimes(1);
    });

    it('endSession() est exécuté sur erreur (session toujours fermée)', async () => {
      audit.log.mockRejectedValue(new Error('audit down'));
      await expect(service.create(baseDto, SELLER_OBJECT_ID)).rejects.toThrow(
        'audit down',
      );
      expect(fixture.session.endSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('même session transmise aux trois écritures', () => {
    it('transmet la MÊME référence de session au stock, à la vente et à l’audit', async () => {
      await service.create(baseDto, SELLER_OBJECT_ID);

      const decSession = products.decrementStock.mock.calls[0][2] as unknown;
      const saleOpts = saleModel.create.mock.calls[0][1] as {
        session?: unknown;
      };
      const auditSession = audit.log.mock.calls[0][4] as unknown;

      // MÊME instance (référence) — pas une copie — et c'est bien la session
      // produite par `startSession()`.
      expect(decSession).toBe(fixture.session);
      expect(saleOpts.session).toBe(fixture.session);
      expect(auditSession).toBe(fixture.session);
    });
  });

  describe('messages métier conservés (rejet issus de la décrémentation)', () => {
    it('repropage le 404 produit absent sans sale, sans audit, sans événement', async () => {
      products.decrementStock.mockRejectedValue(
        new Error(`Product ${PRODUCT_OBJECT_ID} not found`),
      );
      const err = await thrown<Error>(
        service.create(baseDto, SELLER_OBJECT_ID),
      );
      expect(err).toBeDefined();
      expect(err.message).toBe(`Product ${PRODUCT_OBJECT_ID} not found`);
      expect(saleModel.create).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
      expect(fixture.session.endSession).toHaveBeenCalledTimes(1);
    });

    it('repropage le 400 stock insuffisant sans sale, sans audit, sans événement', async () => {
      products.decrementStock.mockRejectedValue(
        new BadRequestException('Not enough stock. Available: 2'),
      );
      const err = await thrown<Error>(
        service.create(baseDto, SELLER_OBJECT_ID),
      );
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toContain('Not enough stock. Available: 2');
      expect(saleModel.create).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('succès et événement post-commit', () => {
    it('détache la session, peuple et émet sale:created APRÈS le commit', async () => {
      const result = await service.create(baseDto, SELLER_OBJECT_ID);

      // le populate post-commit renvoie la même entité (mock) :
      expect(result).toBe(saleEntity);
      // l'audit référence la VENTE réellement créée :
      expect(audit.log).toHaveBeenCalledWith(
        PRODUCT_OBJECT_ID,
        AuditAction.SOLD,
        SELLER_OBJECT_ID,
        expect.objectContaining({
          saleId: saleEntity._id,
          quantity: 3,
          salePrice: 500,
          buyerName: 'Bob',
        }),
        fixture.session,
      );
      // la session est détachée du document créé (null) :
      expect(saleEntity.$session).toHaveBeenCalledWith(null);
      // `$session(null)` est appelé AVANT `populate` (ordre d'exécution réel) :
      const detachOrder = saleEntity.$session.mock.invocationCallOrder[0];
      const populateOrder = saleEntity.populate.mock.invocationCallOrder[0];
      expect(detachOrder).toBeDefined();
      expect(populateOrder).toBeDefined();
      expect(detachOrder).toBeLessThan(populateOrder);
      expect(events.emit).toHaveBeenCalledTimes(1);
      expect(events.emit).toHaveBeenCalledWith(
        'sale:created',
        expect.objectContaining({ _id: saleEntity._id }),
      );
      expect(fixture.session.endSession).toHaveBeenCalledTimes(1);
    });

    it('aucun populate ni événement si la transaction échoue (rollback)', async () => {
      audit.log.mockRejectedValue(new Error('simulated audit failure'));
      await expect(service.create(baseDto, SELLER_OBJECT_ID)).rejects.toThrow(
        'simulated audit failure',
      );

      expect(saleEntity.populate).not.toHaveBeenCalled();
      expect(saleEntity.$session).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
      expect(fixture.session.endSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('snapshot produit et identifiants de la vente créée', () => {
    it('créée la vente avec le productId, la quantity et le sellerId attendus', async () => {
      await service.create(baseDto, SELLER_OBJECT_ID);
      const [docs] = saleModel.create.mock.calls[0] as unknown as [
        Record<string, unknown>[],
      ];
      expect(docs).toHaveLength(1);
      expect((docs[0].productId as { toString: () => string }).toString()).toBe(
        PRODUCT_OBJECT_ID,
      );
      expect(docs[0].quantity).toBe(3);
      expect(docs[0].productName).toBe('Produit A');
      expect((docs[0].sellerId as { toString: () => string }).toString()).toBe(
        SELLER_OBJECT_ID,
      );
    });
  });

  describe('update — stock adjusté hors transaction (comportement actuel)', () => {
    it('baisser la quantity restaure le stock (delta) et audite SALE_UPDATED', async () => {
      const entity = makeSaleEntity();
      entity.save = jest.fn(() => Promise.resolve(entity));
      saleModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(entity),
      });

      await service.update(SALE_OBJECT_ID, { quantity: 2 }, 'actor-1');

      expect(products.adjustStock).toHaveBeenCalledWith(PRODUCT_OBJECT_ID, 2);
      expect(entity.quantity).toBe(2);
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
  });

  describe('remove — stock restauré hors transaction (comportement actuel)', () => {
    it('restaure le stock et audite SALE_CANCELLED', async () => {
      const entity = makeSaleEntity({ quantity: 3, salePrice: 500 });
      entity.deleteOne = jest.fn(() => Promise.resolve(entity));
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
        expect.objectContaining({ saleId: SALE_OBJECT_ID, quantity: 3 }),
      );
    });
  });
});
