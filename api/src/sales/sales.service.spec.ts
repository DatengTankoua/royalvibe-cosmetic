import { BadRequestException, NotFoundException } from '@nestjs/common';
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
// 1-4C.1 : l'organisation TENANT (celle du vendeur, branchée par la garde).
const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ORG_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

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
    // 1-4C.1 : une vente créée par `create` porte TOUJOURS l'org serveur.
    organizationId: new Types.ObjectId(ORG_A),
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
  let saleModel: { create: jest.Mock; find: jest.Mock; findOne: jest.Mock };
  let products: {
    decrementStock: jest.Mock;
    adjustStock: jest.Mock;
    findOne: jest.Mock;
  };
  let audit: { log: jest.Mock };
  let events: { emitToOrganization: jest.Mock };
  let fixture: ReturnType<typeof makeSessionFixture>;
  let saleEntity: SaleEntityRecord;

  beforeEach(async () => {
    fixture = makeSessionFixture();

    saleEntity = makeSaleEntity();
    // `create([doc], { session })` (overload tableau) résout un TABLEAU :
    saleModel = {
      create: jest.fn().mockResolvedValue([saleEntity]),
      find: jest.fn(),
      findOne: jest.fn(),
    };
    products = {
      // par défaut : décrémentation validée, renvoie le produit.
      decrementStock: jest.fn().mockResolvedValue(makeProduct()),
      adjustStock: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    events = { emitToOrganization: jest.fn() };

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
      await service.create(ORG_A, baseDto, SELLER_OBJECT_ID);
      expect(fixture.connection.startSession).toHaveBeenCalledTimes(1);
    });

    it('withTransaction() est utilisé pour encapsuler les écritures', async () => {
      await service.create(ORG_A, baseDto, SELLER_OBJECT_ID);
      expect(fixture.session.withTransaction).toHaveBeenCalledTimes(1);
      const cb = fixture.session.withTransaction.mock.calls[0][0] as unknown;
      expect(typeof cb).toBe('function');
    });

    it('endSession() est exécuté sur succès', async () => {
      await service.create(ORG_A, baseDto, SELLER_OBJECT_ID);
      expect(fixture.session.endSession).toHaveBeenCalledTimes(1);
    });

    it('endSession() est exécuté sur erreur (session toujours fermée)', async () => {
      audit.log.mockRejectedValue(new Error('audit down'));
      await expect(
        service.create(ORG_A, baseDto, SELLER_OBJECT_ID),
      ).rejects.toThrow('audit down');
      expect(fixture.session.endSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('même session transmise aux trois écritures', () => {
    it('transmet la MÊME référence de session au stock, à la vente et à l’audit', async () => {
      await service.create(ORG_A, baseDto, SELLER_OBJECT_ID);

      // `decrementStock(organizationId, productId, quantity, session)` :
      // l'org est en position 0, la session en position 3.
      const decSession = products.decrementStock.mock.calls[0][3] as unknown;
      const saleOpts = saleModel.create.mock.calls[0][1] as {
        session?: unknown;
      };
      // `auditService.log(organizationId, …, session)` : session en position 5.
      const auditSession = audit.log.mock.calls[0][5] as unknown;

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
        new NotFoundException(`Product ${PRODUCT_OBJECT_ID} not found`),
      );
      const err = await thrown<Error>(
        service.create(ORG_A, baseDto, SELLER_OBJECT_ID),
      );
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe(`Product ${PRODUCT_OBJECT_ID} not found`);
      expect(saleModel.create).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(events.emitToOrganization).not.toHaveBeenCalled();
      expect(fixture.session.endSession).toHaveBeenCalledTimes(1);
    });

    it('repropage le 400 stock insuffisant sans sale, sans audit, sans événement', async () => {
      products.decrementStock.mockRejectedValue(
        new BadRequestException('Not enough stock. Available: 2'),
      );
      const err = await thrown<Error>(
        service.create(ORG_A, baseDto, SELLER_OBJECT_ID),
      );
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toContain('Not enough stock. Available: 2');
      expect(saleModel.create).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(events.emitToOrganization).not.toHaveBeenCalled();
    });
  });

  describe('succès et événement post-commit', () => {
    it('détache la session, peuple et émet sale:created APRÈS le commit', async () => {
      const result = await service.create(ORG_A, baseDto, SELLER_OBJECT_ID);

      // le populate post-commit renvoie la même entité (mock) :
      expect(result).toBe(saleEntity);
      // l'audit référence la VENTE réellement créée et reçoit l'org SERVEUR :
      expect(audit.log).toHaveBeenCalledWith(
        ORG_A,
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
      // `$session(null)` (détachement) est appelé AVANT `populate` (ordre
      // d'exécution réel) :
      const detachOrder = saleEntity.$session.mock.invocationCallOrder[0];
      const populateOrder = saleEntity.populate.mock.invocationCallOrder[0];
      expect(detachOrder).toBeDefined();
      expect(populateOrder).toBeDefined();
      expect(detachOrder).toBeLessThan(populateOrder);
      expect(events.emitToOrganization).toHaveBeenCalledTimes(1);
      expect(events.emitToOrganization).toHaveBeenCalledWith(
        ORG_A,
        'sale:created',
        expect.objectContaining({ _id: saleEntity._id }),
      );
      expect(fixture.session.endSession).toHaveBeenCalledTimes(1);
    });

    it('aucun populate ni événement si la transaction échoue (rollback)', async () => {
      audit.log.mockRejectedValue(new Error('simulated audit failure'));
      await expect(
        service.create(ORG_A, baseDto, SELLER_OBJECT_ID),
      ).rejects.toThrow('simulated audit failure');

      expect(saleEntity.populate).not.toHaveBeenCalled();
      expect(saleEntity.$session).not.toHaveBeenCalled();
      expect(events.emitToOrganization).not.toHaveBeenCalled();
      expect(fixture.session.endSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('snapshot produit et identifiants de la vente créée', () => {
    it('crée la vente avec le productId, la quantity, l’org SERVEUR et le sellerId attendus', async () => {
      await service.create(ORG_A, baseDto, SELLER_OBJECT_ID);
      const [docs] = saleModel.create.mock.calls[0] as unknown as [
        Record<string, unknown>[],
      ];
      expect(docs).toHaveLength(1);
      expect((docs[0].productId as { toString: () => string }).toString()).toBe(
        PRODUCT_OBJECT_ID,
      );
      expect(docs[0].quantity).toBe(3);
      expect(docs[0].productName).toBe('Produit A');
      // 1-4C.1 : l'org SERVEUR est écrite dans le document de vente.
      expect(String(docs[0].organizationId)).toBe(ORG_A);
      expect((docs[0].sellerId as { toString: () => string }).toString()).toBe(
        SELLER_OBJECT_ID,
      );
    });
  });

  describe('isolation et transactions des autres opérations (1-4C.2)', () => {
    it('findAll filtre exactement par organisation et produit', async () => {
      const chain = {
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      };
      saleModel.find.mockReturnValue(chain);

      await service.findAll(ORG_A, PRODUCT_OBJECT_ID);

      expect(saleModel.find).toHaveBeenCalledWith({
        organizationId: new Types.ObjectId(ORG_A),
        productId: new Types.ObjectId(PRODUCT_OBJECT_ID),
      });
    });

    it('update filtre la vente par tenant et transmet la même session aux trois écritures', async () => {
      const entity = makeSaleEntity();
      entity.save = jest.fn(() => Promise.resolve(entity));
      saleModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(entity),
      });

      await service.update(ORG_A, SALE_OBJECT_ID, { quantity: 2 }, 'actor-1');

      expect(saleModel.findOne).toHaveBeenCalledWith(
        {
          _id: new Types.ObjectId(SALE_OBJECT_ID),
          organizationId: new Types.ObjectId(ORG_A),
        },
        null,
        { session: fixture.session },
      );
      expect(products.adjustStock).toHaveBeenCalledWith(
        ORG_A,
        PRODUCT_OBJECT_ID,
        2,
        fixture.session,
      );
      expect(entity.save).toHaveBeenCalledWith({ session: fixture.session });
      expect(entity.quantity).toBe(2);
      expect(audit.log).toHaveBeenCalledWith(
        ORG_A,
        PRODUCT_OBJECT_ID,
        AuditAction.SALE_UPDATED,
        'actor-1',
        expect.objectContaining({
          saleId: SALE_OBJECT_ID,
          quantity: { from: 4, to: 2 },
        }),
        fixture.session,
      );
      expect(entity.$session).toHaveBeenCalledWith(null);
      expect(fixture.endSession).toHaveBeenCalledTimes(1);
    });

    it('update étranger est indistinguable de l’absent et ne produit aucune écriture', async () => {
      saleModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.update(ORG_A, SALE_OBJECT_ID, { quantity: 2 }, 'actor-1'),
      ).rejects.toThrow(`Sale ${SALE_OBJECT_ID} not found`);
      expect(products.adjustStock).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(fixture.endSession).toHaveBeenCalledTimes(1);
    });

    it('update propage l’échec audit avant tout effet post-commit', async () => {
      const entity = makeSaleEntity();
      entity.save = jest.fn(() => Promise.resolve(entity));
      saleModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(entity),
      });
      audit.log.mockRejectedValue(new Error('update audit failure'));

      await expect(
        service.update(ORG_A, SALE_OBJECT_ID, { quantity: 2 }, 'actor-1'),
      ).rejects.toThrow('update audit failure');
      expect(entity.populate).not.toHaveBeenCalled();
      expect(fixture.endSession).toHaveBeenCalledTimes(1);
    });

    it('remove restaure le stock, supprime et audite avec la même session et la même org', async () => {
      const entity = makeSaleEntity({ quantity: 3, salePrice: 500 });
      entity.deleteOne = jest.fn(() => Promise.resolve(entity));
      saleModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(entity),
      });

      await service.remove(ORG_A, SALE_OBJECT_ID, 'actor-1');

      expect(products.adjustStock).toHaveBeenCalledWith(
        ORG_A,
        PRODUCT_OBJECT_ID,
        3,
        fixture.session,
      );
      expect(entity.deleteOne).toHaveBeenCalledWith({
        session: fixture.session,
      });
      expect(audit.log).toHaveBeenCalledWith(
        ORG_A,
        PRODUCT_OBJECT_ID,
        AuditAction.SALE_CANCELLED,
        'actor-1',
        expect.objectContaining({ saleId: SALE_OBJECT_ID, quantity: 3 }),
        fixture.session,
      );
      expect(fixture.endSession).toHaveBeenCalledTimes(1);
    });

    it('remove propage l’échec audit dans la transaction', async () => {
      const entity = makeSaleEntity({ quantity: 3 });
      entity.deleteOne = jest.fn(() => Promise.resolve(entity));
      saleModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(entity),
      });
      audit.log.mockRejectedValue(new Error('remove audit failure'));

      await expect(
        service.remove(ORG_A, SALE_OBJECT_ID, 'actor-1'),
      ).rejects.toThrow('remove audit failure');
      expect(fixture.endSession).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * Vente tenant (1-4C.1) — l'origine de l'organisation est UNIQUEMENT le
 * contexte branché par la garde (ICI : le 1er argument `organizationId`
 * obligatoire du service, transmis par le contrôleur). Le DTO ne la porte
 * JAMAIS et ne peut jamais la déterminer.
 */
describe('SalesService — vente tenant (1-4C.1)', () => {
  let service: SalesService;
  let saleModel: { create: jest.Mock };
  let products: { decrementStock: jest.Mock; adjustStock: jest.Mock };
  let audit: { log: jest.Mock };
  let events: { emitToOrganization: jest.Mock };
  let fixture: ReturnType<typeof makeSessionFixture>;
  let saleEntity: SaleEntityRecord;

  const baseDto = {
    productId: PRODUCT_OBJECT_ID,
    quantity: 3,
    salePrice: 500,
    buyerName: 'Bob',
  };

  beforeEach(async () => {
    fixture = makeSessionFixture();
    saleEntity = makeSaleEntity();
    saleModel = { create: jest.fn().mockResolvedValue([saleEntity]) };
    products = {
      decrementStock: jest.fn().mockResolvedValue(makeProduct()),
      adjustStock: jest.fn().mockResolvedValue(undefined),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    events = { emitToOrganization: jest.fn() };

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

  it('le DTO ne détermine JAMAIS l’organisation : un `organizationId` falsifié dans le body est ignoré', async () => {
    // Un attaquant injecterait `organizationId: B` dans le corps (simulé ici
    // via le cast : le DTO whitelisté le rejette déjà en E2E, mais le service
    // ne doit PAS non plus copier un tel champ).
    const forgedDto = { ...baseDto, organizationId: ORG_B } as typeof baseDto;

    await service.create(ORG_A, forgedDto, SELLER_OBJECT_ID);

    const [docs] = saleModel.create.mock.calls[0] as unknown as [
      Record<string, unknown>[],
    ];
    // l'org écrite est A (celle du 1er argument), jamais B.
    expect(String(docs[0].organizationId)).toBe(ORG_A);
  });

  it('la vente créée porte l’organisation SERVEUR (1er argument du create)', async () => {
    await service.create(ORG_A, baseDto, SELLER_OBJECT_ID);
    const [docs] = saleModel.create.mock.calls[0] as unknown as [
      Record<string, unknown>[],
    ];
    expect(docs[0].organizationId).toBeInstanceOf(Types.ObjectId);
    expect(String(docs[0].organizationId)).toBe(ORG_A);
  });

  it('decrementStock reçoit l’org MÊME que la vente (1er argument, MÊME chaîne)', async () => {
    await service.create(ORG_A, baseDto, SELLER_OBJECT_ID);
    expect(products.decrementStock).toHaveBeenCalledTimes(1);
    const [orgArg, productIdArg, qtyArg, sessionArg] =
      products.decrementStock.mock.calls[0];
    expect(orgArg).toBe(ORG_A);
    expect(productIdArg).toBe(baseDto.productId);
    expect(qtyArg).toBe(3);
    expect(sessionArg).toBe(fixture.session);
  });

  it('l’AuditService.log reçoit l’org SERVEUR en 1er argument et la session en 6e', async () => {
    await service.create(ORG_A, baseDto, SELLER_OBJECT_ID);
    expect(audit.log).toHaveBeenCalledTimes(1);
    const [orgArg, productArg, actionArg, actorArg, detailsArg, sessionArg] =
      audit.log.mock.calls[0] as [
        string,
        string,
        AuditAction,
        string,
        Record<string, unknown>,
        unknown,
      ];
    expect(orgArg).toBe(ORG_A);
    expect(productArg).toBe(baseDto.productId);
    expect(actionArg).toBe(AuditAction.SOLD);
    expect(actorArg).toBe(SELLER_OBJECT_ID);
    expect(detailsArg).toEqual(
      expect.objectContaining({ saleId: saleEntity._id, quantity: 3 }),
    );
    expect(sessionArg).toBe(fixture.session);
  });

  it('stock insuffisant ORG_A → 400 métier, aucune vente, aucun audit, aucun événement', async () => {
    products.decrementStock.mockRejectedValue(
      new BadRequestException('Not enough stock. Available: 1'),
    );
    const err = await thrown<Error>(
      service.create(ORG_A, baseDto, SELLER_OBJECT_ID),
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Not enough stock. Available: 1');
    expect(saleModel.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(events.emitToOrganization).not.toHaveBeenCalled();
    expect(fixture.session.endSession).toHaveBeenCalledTimes(1);
  });

  it('décrémentage de l’org A : si la transaction échoue à l’audit, endSession est appelé', async () => {
    products.decrementStock.mockResolvedValue(makeProduct());
    audit.log.mockRejectedValue(new Error('org-a audit failure'));
    await expect(
      service.create(ORG_A, baseDto, SELLER_OBJECT_ID),
    ).rejects.toThrow('org-a audit failure');
    expect(fixture.session.endSession).toHaveBeenCalledTimes(1);
    expect(saleEntity.populate).not.toHaveBeenCalled();
    expect(events.emitToOrganization).not.toHaveBeenCalled();
  });
});
