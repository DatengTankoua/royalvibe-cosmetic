import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { ProductsService } from './products.service';
import { Product } from './schemas/product.schema';
import { Sale } from '../sales/schemas/sale.schema';
import { Section } from '../sections/schemas/section.schema';
import { S3Service } from '../s3/s3.service';
import { EventsGateway } from '../events/events.gateway';
import { AuditService } from '../audit/audit.service';

const PRODUCT_OBJECT_ID = '112233445566778899001122';
const UNKNOWN_PRODUCT_ID = '6300000000000000000000f1';

/** Session transactionnelle de test (référence unique, comparée par `toBe`). */
function makeSession() {
  return {
    endSession: jest.fn().mockResolvedValue(true),
    abortTransaction: jest.fn(),
    commitTransaction: jest.fn(),
  };
}

function makeUpdateChain(result: unknown) {
  return { exec: jest.fn().mockResolvedValue(result) };
}

function makeFindChain(result: unknown) {
  return { exec: jest.fn().mockResolvedValue(result) };
}

describe('ProductsService.decrementStock — décrémentation atomique (0B.7B)', () => {
  let service: ProductsService;
  let productModel: {
    findOneAndUpdate: jest.Mock;
    findOne: jest.Mock;
  };
  let session: ReturnType<typeof makeSession>;

  const baseOpts = {
    s3Service: { uploadFile: jest.fn(), deleteFile: jest.fn() },
    eventsGateway: { emit: jest.fn() },
    auditService: { log: jest.fn(), findByProduct: jest.fn() },
    saleModel: {},
    sectionModel: {},
  };

  async function build() {
    const updateChain = makeUpdateChain(null);
    const findChain = makeFindChain(null);
    productModel = {
      findOneAndUpdate: jest.fn(() => updateChain),
      findOne: jest.fn(() => findChain),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: getModelToken(Product.name), useValue: productModel },
        { provide: getModelToken(Sale.name), useValue: baseOpts.saleModel },
        {
          provide: getModelToken(Section.name),
          useValue: baseOpts.sectionModel,
        },
        { provide: S3Service, useValue: baseOpts.s3Service },
        { provide: EventsGateway, useValue: baseOpts.eventsGateway },
        { provide: AuditService, useValue: baseOpts.auditService },
      ],
    }).compile();
    service = module.get(ProductsService);
    return { updateChain, findChain };
  }

  beforeEach(() => {
    session = makeSession();
  });

  it('utilise un filtre atomique $gte et renvoie le produit (session transmise)', async () => {
    const product = {
      _id: new Types.ObjectId(PRODUCT_OBJECT_ID),
      name: 'X',
      remainingQuantity: 7,
    };
    const { updateChain } = await build();
    updateChain.exec.mockResolvedValue(product);

    const res = await service.decrementStock(PRODUCT_OBJECT_ID, 3, session);

    expect(res).toBe(product);
    const [filter, update, options] = productModel.findOneAndUpdate.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(filter).toEqual({
      _id: new Types.ObjectId(PRODUCT_OBJECT_ID),
      deletedAt: null,
      remainingQuantity: { $gte: 3 },
    });
    expect(update).toEqual({ $inc: { remainingQuantity: -3 } });
    // la MÊME instance de session est associée à la mise à jour :
    expect(options.session).toBe(session);
    expect(options.returnDocument).toBe('after');
  });

  it('produit absent → 404 exact ; relecture ACTIVE (_id + deletedAt:null) en même session', async () => {
    const { findChain } = await build();
    findChain.exec.mockResolvedValue(null);

    const err = await service
      .decrementStock(PRODUCT_OBJECT_ID, 3, session)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as Error).message).toBe(
      `Product ${PRODUCT_OBJECT_ID} not found`,
    );

    // la relecture d'erreur cible UNIQUEMENT un produit actif :
    const [filter, projection, opts] = productModel.findOne.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
      Record<string, unknown>,
    ];
    expect(filter).toEqual({
      _id: new Types.ObjectId(PRODUCT_OBJECT_ID),
      deletedAt: null,
    });
    // la MÊME session est transmise à la mise à jour ET à la relecture :
    const updateOptions = (
      productModel.findOneAndUpdate.mock.calls[0] as [
        unknown,
        unknown,
        Record<string, unknown>,
      ]
    )[2];
    expect(opts.session).toBe(session);
    expect(updateOptions.session).toBe(session);
    void projection;
  });

  it('produit actif mais stock insuffisant → 400 avec la quantité disponible', async () => {
    const { findChain } = await build();
    findChain.exec.mockResolvedValue({
      _id: new Types.ObjectId(PRODUCT_OBJECT_ID),
      remainingQuantity: 2,
    });

    const err = await service
      .decrementStock(PRODUCT_OBJECT_ID, 3, session)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe('Not enough stock. Available: 2');
    // la relecture d'erreur a bien eu lieu (une fois) :
    expect(productModel.findOne).toHaveBeenCalledTimes(1);
  });

  it('produit corbeillé (deletedAt non nul) → 404, pas de « Not enough stock »', async () => {
    // la relecture filtre `deletedAt: null` : un produit corbeillé n'est pas
    // « retrouvé » par le `findOne` (la base ne renvoie que les actifs) → 404.
    const { findChain } = await build();
    // Simule la sémantique du filtre `{ _id, deletedAt: null }` : le produit
    // est absent du lot actif.
    findChain.exec.mockImplementation(() => Promise.resolve(null));

    const err = await service
      .decrementStock(UNKNOWN_PRODUCT_ID, 3, session)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as Error).message).not.toContain('Not enough stock');
  });

  it('sans session, la mise à jour est exécutée sans session (null)', async () => {
    const { updateChain } = await build();
    updateChain.exec.mockResolvedValue({ remainingQuantity: 1 });

    await service.decrementStock(PRODUCT_OBJECT_ID, 1);

    const [, , options] = productModel.findOneAndUpdate.mock
      .calls[0] as unknown as [unknown, unknown, { session?: unknown }];
    expect(options.session).toBeNull();
  });
});
