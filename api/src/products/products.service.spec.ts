import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { ProductsService } from './products.service';
import { Product } from './schemas/product.schema';
import { Sale } from '../sales/schemas/sale.schema';
import { Section } from '../sections/schemas/section.schema';
import { S3Service } from '../s3/s3.service';
import { EventsGateway } from '../events/events.gateway';
import { AuditService } from '../audit/audit.service';
import { PurgedStockAdjustment } from './schemas/purged-stock-adjustment.schema';

const PRODUCT_OBJECT_ID = '112233445566778899001122';
const UNKNOWN_PRODUCT_ID = '6300000000000000000000f1';
// Org tenant du bloc 0B.7B (1-4C.1) — `decrementStock` en est désormais
// le 1er argument obligatoire.
const TRADE_ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';

/** Session transactionnelle de test (référence unique, comparée par `toBe`). */
function makeSession() {
  return {
    endSession: jest.fn().mockResolvedValue(true),
    abortTransaction: jest.fn(),
    commitTransaction: jest.fn(),
  };
}

/**
 * 1-15D — connexion de test : `withTransaction` exécute le callback une fois
 * (le pilote réel peut le rejouer ; voir l'e2e de purge).
 */
function makeConnection() {
  const session = {
    withTransaction: jest.fn((fn: () => Promise<void>) => fn()),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
  return {
    session,
    connection: { startSession: jest.fn().mockResolvedValue(session) },
  };
}

/**
 * 1-15E — équivalent de `Document.getChanges()` pour les documents simulés :
 * `$set` des champs modifiés depuis la création du mock (stock compris, pour
 * qu'une écriture absolue du stock soit visible).
 */
const TRACKED_PRODUCT_FIELDS = [
  'name',
  'imageUrl',
  'imageKey',
  'imageStorage',
  'purchasePrice',
  'salePrice',
  'sectionId',
  'initialQuantity',
  'remainingQuantity',
  'organizationId',
];
function trackChanges(doc: Record<string, unknown>) {
  const initial = { ...doc };
  doc.getChanges = jest.fn(() => {
    const $set: Record<string, unknown> = {};
    for (const key of TRACKED_PRODUCT_FIELDS) {
      if (doc[key] !== initial[key]) $set[key] = doc[key];
    }
    return Object.keys($set).length ? { $set } : {};
  });
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
    s3Service: {
      signedReadUrl: jest.fn(),
      deleteStoredObject: jest.fn(),
    },
    eventsGateway: { emitToOrganization: jest.fn() },
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
        {
          provide: getModelToken(PurgedStockAdjustment.name),
          useValue: {},
        },
        { provide: getModelToken(Sale.name), useValue: baseOpts.saleModel },
        {
          provide: getModelToken(Section.name),
          useValue: baseOpts.sectionModel,
        },
        { provide: S3Service, useValue: baseOpts.s3Service },
        { provide: EventsGateway, useValue: baseOpts.eventsGateway },
        { provide: AuditService, useValue: baseOpts.auditService },
        {
          provide: getConnectionToken(),
          useValue: makeConnection().connection,
        },
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

    const res = await service.decrementStock(
      TRADE_ORG_A,
      PRODUCT_OBJECT_ID,
      3,
      session,
    );

    expect(res).toBe(product);
    const [filter, update, options] = productModel.findOneAndUpdate.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    // 1-4C.1 : le filtre atomique porte le tenant (`_id` + `organizationId`).
    expect(filter).toEqual({
      _id: new Types.ObjectId(PRODUCT_OBJECT_ID),
      organizationId: new Types.ObjectId(TRADE_ORG_A),
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
      .decrementStock(TRADE_ORG_A, PRODUCT_OBJECT_ID, 3, session)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as Error).message).toBe(
      `Product ${PRODUCT_OBJECT_ID} not found`,
    );
    // 1-11C.1 : code stable ajouté, message historique conservé.
    expect((err as NotFoundException).getResponse()).toEqual({
      code: 'PRODUCT_NOT_FOUND',
      message: `Product ${PRODUCT_OBJECT_ID} not found`,
    });

    // 1-4C.1 : la relecture d'erreur cible UNIQUEMENT un produit actif du
    // MÊME tenant : `{_id, organizationId, deletedAt:null}`.
    const [filter, projection, opts] = productModel.findOne.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
      Record<string, unknown>,
    ];
    expect(filter).toEqual({
      _id: new Types.ObjectId(PRODUCT_OBJECT_ID),
      organizationId: new Types.ObjectId(TRADE_ORG_A),
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
      .decrementStock(TRADE_ORG_A, PRODUCT_OBJECT_ID, 3, session)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe('Not enough stock. Available: 2');
    expect((err as BadRequestException).getResponse()).toEqual({
      code: 'INSUFFICIENT_STOCK',
      message: 'Not enough stock. Available: 2',
      available: 2,
    });
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
      .decrementStock(TRADE_ORG_A, UNKNOWN_PRODUCT_ID, 3, session)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as Error).message).not.toContain('Not enough stock');
  });

  it('sans session, la mise à jour est exécutée sans session (null)', async () => {
    const { updateChain } = await build();
    updateChain.exec.mockResolvedValue({ remainingQuantity: 1 });

    await service.decrementStock(TRADE_ORG_A, PRODUCT_OBJECT_ID, 1);

    const [, , options] = productModel.findOneAndUpdate.mock
      .calls[0] as unknown as [unknown, unknown, { session?: unknown }];
    expect(options.session).toBeNull();
  });
});

/**
 * Chemin catalogue HTTP (1-4B) — `organizationId` obligatoire, tenant dans
 * CHAQUE filtre, section validée dans la même org, $set strict, S3 jamais
 * touché pour un produit étranger. Les chemins transactionnels
 * `decrementStock`/`adjustStock` (1-4C) ne sont PAS testés ici.
 */
describe('ProductsService — isolation multi-tenant catalogue (1-4B)', () => {
  let service: ProductsService;
  let productModel: {
    create: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
    findOneAndDelete: jest.Mock;
  };
  let sectionModel: { findOne: jest.Mock; countDocuments: jest.Mock };
  let saleModel: {
    find: jest.Mock;
    aggregate: jest.Mock;
    updateMany: jest.Mock;
  };
  let aggregateChain: { session: jest.Mock; exec: jest.Mock };
  let stockAdjustmentModel: { create: jest.Mock };
  let updateManyChain: { exec: jest.Mock };
  let tx: ReturnType<typeof makeConnection>;
  let s3Service: { signedReadUrl: jest.Mock; deleteStoredObject: jest.Mock };
  let auditService: { log: jest.Mock; findByProduct: jest.Mock };
  let eventsGateway: { emitToOrganization: jest.Mock };
  let findChain: { sort: jest.Mock; exec: jest.Mock };
  let updateChain: { exec: jest.Mock };
  let deleteChain: { exec: jest.Mock };
  let saleChain: { populate: jest.Mock; sort: jest.Mock; exec: jest.Mock };
  // Chaînes `findOne(...).exec()` / `countDocuments(...).exec()` (même
  // pattern que le bloc 0B.7B) : `await Model.findOne()` est une Query
  // thenable, mais l'idiome du service est explicite sur `.exec()`.
  let productOneChain: { exec: jest.Mock };
  let sectionOneChain: { exec: jest.Mock };
  let countChain: { exec: jest.Mock };

  const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const ORG_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const SECTION_ID = '112233445566778899001122';
  const FOREIGN_SECTION_ID = 'cccccccccccccccccccccccc';
  const PRODUCT_ID = '223344556677889900112233';
  const STORAGE = 'r2/stockmaster-prod';
  const PREFIX_A = `organizations/${ORG_A}/products`;
  const IMAGE = { key: `${PREFIX_A}/new.jpg`, storage: STORAGE };

  const DTO = {
    sectionId: SECTION_ID,
    name: 'Prod',
    purchasePrice: 5,
    salePrice: 10,
    initialQuantity: 7,
  };

  function sectionDoc(org: string = ORG_A) {
    return {
      _id: new Types.ObjectId(SECTION_ID),
      name: 'Sec',
      deletedAt: null,
      organizationId: new Types.ObjectId(org),
    };
  }

  function productDoc(overrides: Record<string, unknown> = {}) {
    const doc: Record<string, unknown> = {
      _id: new Types.ObjectId(PRODUCT_ID),
      sectionId: new Types.ObjectId(SECTION_ID),
      name: 'Prod',
      imageKey: `organizations/${ORG_A}/products/p.jpg`,
      imageStorage: 'r2/stockmaster-prod',
      purchasePrice: 5,
      salePrice: 10,
      initialQuantity: 10,
      remainingQuantity: 10,
      deletedAt: null,
      organizationId: new Types.ObjectId(ORG_A),
      save: jest.fn(),
      ...overrides,
    };
    // Mongoose `save()` renvoie le document hydraté : le mock le mime.
    (doc.save as jest.Mock).mockResolvedValue(doc);
    trackChanges(doc);
    return doc;
  }

  async function build() {
    findChain = { sort: jest.fn(), exec: jest.fn() };
    findChain.sort.mockReturnValue(findChain);
    updateChain = { exec: jest.fn() };
    deleteChain = { exec: jest.fn() };
    productOneChain = { exec: jest.fn() };
    sectionOneChain = { exec: jest.fn() };
    countChain = { exec: jest.fn() };
    saleChain = { populate: jest.fn(), sort: jest.fn(), exec: jest.fn() };
    saleChain.populate.mockReturnValue(saleChain);
    saleChain.sort.mockReturnValue(saleChain);
    saleChain.exec.mockResolvedValue([]);
    productModel = {
      create: jest.fn(),
      find: jest.fn(() => findChain),
      findOne: jest.fn(() => productOneChain),
      findOneAndUpdate: jest.fn(() => updateChain),
      findOneAndDelete: jest.fn(() => deleteChain),
    };
    sectionModel = {
      findOne: jest.fn(() => sectionOneChain),
      countDocuments: jest.fn(() => countChain),
    };
    aggregateChain = {
      session: jest.fn(),
      exec: jest.fn().mockResolvedValue([]),
    };
    aggregateChain.session.mockReturnValue(aggregateChain);
    stockAdjustmentModel = { create: jest.fn().mockResolvedValue([]) };
    updateManyChain = {
      exec: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    };
    saleModel = {
      find: jest.fn(() => saleChain),
      aggregate: jest.fn(() => aggregateChain),
      updateMany: jest.fn(() => updateManyChain),
    };
    tx = makeConnection();
    s3Service = {
      // Signature simulée : seule une référence du stockage courant (`r2`)
      // reçoit une URL ; le vrai contrôle est couvert par s3.service.spec.
      signedReadUrl: jest.fn((ref: { key: string; storage: string } | null) =>
        Promise.resolve(
          ref && ref.storage === STORAGE ? `https://signed/${ref.key}` : null,
        ),
      ),
      deleteStoredObject: jest.fn().mockResolvedValue('deleted'),
    };
    auditService = { log: jest.fn(), findByProduct: jest.fn() };
    auditService.findByProduct.mockResolvedValue([]);
    eventsGateway = { emitToOrganization: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: getModelToken(Product.name), useValue: productModel },
        {
          provide: getModelToken(PurgedStockAdjustment.name),
          useValue: stockAdjustmentModel,
        },
        { provide: getModelToken(Sale.name), useValue: saleModel },
        { provide: getModelToken(Section.name), useValue: sectionModel },
        { provide: S3Service, useValue: s3Service },
        { provide: EventsGateway, useValue: eventsGateway },
        { provide: AuditService, useValue: auditService },
        { provide: getConnectionToken(), useValue: tx.connection },
      ],
    }).compile();
    service = module.get(ProductsService);
  }

  // ---- create ----

  it('create : écrit l’organisation SERVEUR (falsification runtime ignorée), section validée tenant, sous-sections filtrées, unicité tenant', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(null); // unicité : absent
    sectionOneChain.exec.mockResolvedValue(sectionDoc()); // section A active
    countChain.exec.mockResolvedValue(0); // pas de sous-section
    productModel.create.mockResolvedValue(productDoc());

    // org d'origine runtime fournie (le DTO whitelisté ne peut pas la porter,
    // mais le service ne doit PAS non plus copier un tel champ) :
    const dto = { ...DTO, organizationId: ORG_B };
    const created = await service.create(ORG_A, dto, IMAGE, 'actor');

    const written = productModel.create.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(String(written.organizationId)).toBe(ORG_A); // jamais B
    // Référence durable : clé + stockage ; aucune URL (publique ni signée).
    expect(written.imageKey).toBe(IMAGE.key);
    expect(written.imageStorage).toBe(STORAGE);
    expect(written).not.toHaveProperty('imageUrl');
    // URL signée à la réponse (photo du document créé).
    expect(created.imageUrl).toBe(`https://signed/${PREFIX_A}/p.jpg`);
    expect(eventsGateway.emitToOrganization).toHaveBeenCalledWith(
      ORG_A,
      'product:created',
      expect.any(Object),
    );

    // section validée par filtre composite tenant :
    expect(sectionModel.findOne).toHaveBeenCalledWith({
      _id: new Types.ObjectId(SECTION_ID),
      organizationId: new Types.ObjectId(ORG_A),
      deletedAt: null,
    });
    // recherches de sous-sections filtrées par tenant :
    expect(sectionModel.countDocuments).toHaveBeenCalledWith({
      organizationId: new Types.ObjectId(ORG_A),
      parentId: new Types.ObjectId(SECTION_ID),
      deletedAt: null,
    });
    // unicité de nom filtrée par tenant :
    expect(productModel.findOne).toHaveBeenCalledWith({
      name: expect.any(RegExp),
      organizationId: new Types.ObjectId(ORG_A),
    });
  });

  it('create : section étrangère/absente → 404 `Section`, aucune création, pas de sous-section check', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(null);
    sectionOneChain.exec.mockResolvedValue(null); // pas dans A (étrangère)
    countChain.exec.mockResolvedValue(99);

    const err = await service
      .create(ORG_A, DTO, IMAGE, 'actor')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as Error).message).toBe(`Section ${SECTION_ID} not found`);
    expect(sectionModel.countDocuments).not.toHaveBeenCalled();
    expect(productModel.create).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('create : sous-sections actives dans l’org → 400 SECTION_HAS_SUBSECTIONS (filtre tenant prouvé)', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(null);
    sectionOneChain.exec.mockResolvedValue(sectionDoc());
    countChain.exec.mockResolvedValue(3);

    const err = await service
      .create(ORG_A, DTO, IMAGE, 'actor')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe('SECTION_HAS_SUBSECTIONS');
    expect(sectionModel.countDocuments).toHaveBeenCalledWith({
      organizationId: new Types.ObjectId(ORG_A),
      parentId: new Types.ObjectId(SECTION_ID),
      deletedAt: null,
    });
    expect(productModel.create).not.toHaveBeenCalled();
  });

  // ---- findAll / findTrashed ----

  it('findAll : filtre EXACT {organizationId, deletedAt, [sectionId]} (+ tri inchangé)', async () => {
    await build();
    findChain.exec.mockResolvedValue([]);

    await service.findAll(ORG_A);
    expect(productModel.find).toHaveBeenNthCalledWith(1, {
      organizationId: new Types.ObjectId(ORG_A),
      deletedAt: null,
    });

    await service.findAll(ORG_A, SECTION_ID);
    expect(productModel.find).toHaveBeenNthCalledWith(2, {
      organizationId: new Types.ObjectId(ORG_A),
      deletedAt: null,
      sectionId: new Types.ObjectId(SECTION_ID),
    });
    expect(findChain.sort).toHaveBeenCalledWith({ createdAt: -1 });
  });

  it('findTrashed : filtre EXACT {organizationId, deletedAt:{$ne:null}}', async () => {
    await build();
    findChain.exec.mockResolvedValue([]);

    await service.findTrashed(ORG_A);

    expect(productModel.find).toHaveBeenCalledWith({
      organizationId: new Types.ObjectId(ORG_A),
      deletedAt: { $ne: null },
    });
    expect(findChain.sort).toHaveBeenCalledWith({ deletedAt: -1 });
  });

  // ---- findOne ----

  const SELLER_ID = 'eeeeeeeeeeeeeeeeeeeeeeee';

  it('findOne : filtre composite {_id, organizationId} puis sales (scope all) + audit inclus', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(productDoc());

    const res = await service.findOne(ORG_A, PRODUCT_ID, { kind: 'all' }, true);

    expect(productModel.findOne).toHaveBeenCalledWith({
      _id: PRODUCT_ID,
      organizationId: new Types.ObjectId(ORG_A),
    });
    expect(res.product.name).toBe('Prod');
    expect(saleModel.find).toHaveBeenCalledWith({
      productId: new Types.ObjectId(PRODUCT_ID),
    });
    expect(auditService.findByProduct).toHaveBeenCalledWith(ORG_A, PRODUCT_ID);
  });

  it('findOne (correctif 1-7B) : scope «own» → filtre sales par sellerId, jamais les ventes d’un AUTRE vendeur', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(productDoc());

    await service.findOne(
      ORG_A,
      PRODUCT_ID,
      { kind: 'own', sellerId: SELLER_ID },
      false,
    );

    expect(saleModel.find).toHaveBeenCalledWith({
      productId: new Types.ObjectId(PRODUCT_ID),
      sellerId: new Types.ObjectId(SELLER_ID),
    });
  });

  it('findOne (correctif 1-7B) : scope «none» → AUCUNE lecture de ventes (jamais interrogées)', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(productDoc());

    const res = await service.findOne(
      ORG_A,
      PRODUCT_ID,
      { kind: 'none' },
      false,
    );

    expect(saleModel.find).not.toHaveBeenCalled();
    expect(res.sales).toEqual([]);
    // 1-12H : sans `products.view_financials` (visibilité par défaut), aucun
    // agrégat n'est lu ni exposé.
    expect(res).not.toHaveProperty('actualRevenue');
    expect(saleModel.aggregate).not.toHaveBeenCalled();
  });

  // ---- 1-12H : agrégats produit indépendants des ventes consultables ----

  const FULL = { stockDetails: true, financials: true };
  const STANDARD = { stockDetails: false, financials: false };
  const FINANCIAL_KEYS = [
    'actualProfit',
    'actualRevenue',
    'margin',
    'totalPurchaseCost',
  ];

  it('findOne (1-12H) : scope «own» + finances → CA réel = agrégat de TOUTES les ventes du produit dans l’org, jamais la liste filtrée', async () => {
    await build();
    // Produit : 10 initial, 5 restants → 5 vendus ; achat 5.
    productOneChain.exec.mockResolvedValue(
      productDoc({ initialQuantity: 10, remainingQuantity: 5 }),
    );
    // Historique scopé du vendeur A : 2 × 1 500 seulement.
    saleChain.exec.mockResolvedValue([{ quantity: 2, salePrice: 1500 }]);
    // Agrégat serveur : A (3 000) + B (6 000).
    aggregateChain.exec.mockResolvedValue([
      { _id: new Types.ObjectId(PRODUCT_ID), revenue: 9000 },
    ]);

    const res = await service.findOne(
      ORG_A,
      PRODUCT_ID,
      { kind: 'own', sellerId: SELLER_ID },
      false,
      FULL,
    );

    expect(saleModel.find).toHaveBeenCalledWith({
      productId: new Types.ObjectId(PRODUCT_ID),
      sellerId: new Types.ObjectId(SELLER_ID),
    });
    const [pipeline] = saleModel.aggregate.mock.calls[0] as [
      Record<string, unknown>[],
    ];
    expect(pipeline[0]).toEqual({
      $match: {
        organizationId: new Types.ObjectId(ORG_A),
        productId: { $in: [new Types.ObjectId(PRODUCT_ID)] },
      },
    });
    expect(JSON.stringify(pipeline)).not.toContain('sellerId');
    expect(res.actualRevenue).toBe(9000);
    expect(res.unitsSold).toBe(5);
    expect(res.actualProfit).toBe(9000 - 5 * 5);
    expect(res.margin).toBeCloseTo(((9000 - 25) / 9000) * 100);
    expect(res.totalPurchaseCost).toBe(5 * 10);
    expect(res.product.purchasePrice).toBe(5);
    expect(res.product.initialQuantity).toBe(10);
    expect(res.sales).toHaveLength(1);
  });

  it('findOne (1-12H) : sans finances → aucun agrégat lu, champs financiers et prix d’achat ABSENTS (jamais 0)', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(productDoc());

    const res = await service.findOne(
      ORG_A,
      PRODUCT_ID,
      { kind: 'own', sellerId: SELLER_ID },
      false,
      STANDARD,
    );

    expect(saleModel.aggregate).not.toHaveBeenCalled();
    for (const key of [...FINANCIAL_KEYS, 'unitsSold']) {
      expect(res).not.toHaveProperty(key);
    }
    expect(res.product).not.toHaveProperty('purchasePrice');
    expect(res.product).not.toHaveProperty('initialQuantity');
    expect(res.product).not.toHaveProperty('organizationId');
    expect(res.product.salePrice).toBe(10);
    expect(res.product.remainingQuantity).toBe(10);
    expect(res.status).toBe('in_stock');
  });

  it('findOne (1-12H) : détail du stock seul → stock initial et unités vendues, aucune donnée financière', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(
      productDoc({ initialQuantity: 10, remainingQuantity: 4 }),
    );

    const res = await service.findOne(
      ORG_A,
      PRODUCT_ID,
      { kind: 'own', sellerId: SELLER_ID },
      false,
      { stockDetails: true, financials: false },
    );

    expect(res.unitsSold).toBe(6);
    expect(res.product.initialQuantity).toBe(10);
    for (const key of FINANCIAL_KEYS) expect(res).not.toHaveProperty(key);
    expect(res.product).not.toHaveProperty('purchasePrice');
    expect(saleModel.aggregate).not.toHaveBeenCalled();
  });

  it('findOne (1-12H) : historique d’audit projeté (prix d’achat, stock initial, quantité ajoutée retirés sans droit)', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(productDoc());
    const log = (details: Record<string, unknown>) => ({
      toObject: () => ({ action: 'x', details }),
    });
    auditService.findByProduct.mockResolvedValue([
      log({ name: 'P', purchasePrice: 5, salePrice: 10, initialQuantity: 3 }),
      log({ purchasePrice: { from: 5, to: 6 } }),
      log({ added: 4 }),
    ]);

    const res = await service.findOne(
      ORG_A,
      PRODUCT_ID,
      { kind: 'all' },
      true,
      STANDARD,
    );
    expect(res.auditLogs).toEqual([
      { action: 'x', details: { name: 'P', salePrice: 10 } },
      { action: 'x', details: {} },
      { action: 'x', details: {} },
    ]);
    const full = await service.findOne(
      ORG_A,
      PRODUCT_ID,
      { kind: 'all' },
      true,
      FULL,
    );
    expect(full.auditLogs[0]).toEqual({
      action: 'x',
      details: {
        name: 'P',
        purchasePrice: 5,
        salePrice: 10,
        initialQuantity: 3,
      },
    });
  });

  it('findAll (1-12H) : un seul agrégat pour tous les produits listés ; produit sans vente → CA 0, marge null', async () => {
    await build();
    const other = '334455667788990011223344';
    findChain.exec.mockResolvedValue([
      productDoc({ initialQuantity: 10, remainingQuantity: 5 }),
      productDoc({
        _id: new Types.ObjectId(other),
        initialQuantity: 3,
        remainingQuantity: 3,
      }),
    ]);
    aggregateChain.exec.mockResolvedValue([
      { _id: new Types.ObjectId(PRODUCT_ID), revenue: 9000 },
    ]);

    const res = await service.findAll(ORG_A, undefined, FULL);

    expect(saleModel.aggregate).toHaveBeenCalledTimes(1);
    expect(res[0].actualRevenue).toBe(9000);
    expect(res[1].actualRevenue).toBe(0);
    expect(res[1].actualProfit).toBe(0);
    expect(res[1].margin).toBeNull();

    const standard = await service.findAll(ORG_A, undefined, STANDARD);
    expect(saleModel.aggregate).toHaveBeenCalledTimes(1); // pas de 2e lecture
    for (const key of [...FINANCIAL_KEYS, 'unitsSold']) {
      expect(standard[0]).not.toHaveProperty(key);
    }
  });

  it('diffusions Socket.IO (1-12H) : create/update/restore → champs standard uniquement, quel que soit le demandeur', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(null);
    sectionOneChain.exec.mockResolvedValue(sectionDoc());
    countChain.exec.mockResolvedValue(0);
    productModel.create.mockResolvedValue(productDoc());
    const created = await service.create(ORG_A, DTO, IMAGE, 'actor', FULL);
    expect(created.purchasePrice).toBe(5); // réponse du demandeur autorisé

    productOneChain.exec.mockResolvedValue(productDoc());
    updateChain.exec.mockResolvedValue(productDoc({ name: 'N' }));
    await service.update(
      ORG_A,
      PRODUCT_ID,
      { name: 'N' },
      'actor',
      undefined,
      FULL,
    );
    updateChain.exec.mockResolvedValue(productDoc());
    await service.restore(ORG_A, PRODUCT_ID, FULL);

    const payloads = eventsGateway.emitToOrganization.mock.calls.map((call) =>
      JSON.stringify(call[2]),
    );
    expect(payloads).toHaveLength(3);
    for (const payload of payloads) {
      for (const key of [
        'purchasePrice',
        'initialQuantity',
        'unitsSold',
        'organizationId',
        ...FINANCIAL_KEYS,
      ]) {
        expect(payload).not.toContain(`"${key}"`);
      }
    }
    expect(saleModel.aggregate).toHaveBeenCalledTimes(1); // update, pour le demandeur
    // Photo : URL signée pour la room de l'organisation, jamais la clé.
    for (const payload of payloads) {
      expect(payload).toContain('https://signed/');
      expect(payload).not.toContain('"imageKey"');
      expect(payload).not.toContain('"imageStorage"');
    }
  });

  it('lecture : photo du stockage courant signée sous le préfixe de l’org ; ancienne URL telle quelle ; autre stockage → null', async () => {
    await build();
    findChain.exec.mockResolvedValue([
      productDoc(),
      productDoc({
        _id: new Types.ObjectId(),
        imageKey: null,
        imageStorage: null,
        imageUrl: 'https://proj.supabase.co/storage/v1/object/public/b/x.png',
      }),
      productDoc({
        _id: new Types.ObjectId(),
        imageStorage: 'ancien/bucket',
      }),
      productDoc({
        _id: new Types.ObjectId(),
        imageKey: null,
        imageStorage: null,
        imageUrl: 'javascript:alert(1)',
      }),
    ]);
    const list = await service.findAll(ORG_A);
    expect(list.map((v) => v.product.imageUrl)).toEqual([
      `https://signed/${PREFIX_A}/p.jpg`,
      'https://proj.supabase.co/storage/v1/object/public/b/x.png',
      null,
      null,
    ]);
    // Toujours le préfixe de l'organisation du DEMANDEUR.
    for (const call of s3Service.signedReadUrl.mock.calls) {
      expect(call[1]).toBe(PREFIX_A);
    }
  });

  it('findOne (correctif 1-7B) : audit.read absent → AUCUNE lecture d’audit (jamais interrogé ni vidé après coup)', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(productDoc());

    const res = await service.findOne(
      ORG_A,
      PRODUCT_ID,
      { kind: 'all' },
      false,
    );

    expect(auditService.findByProduct).not.toHaveBeenCalled();
    expect(res.auditLogs).toEqual([]);
  });

  it('findOne : produit invisible dans l’org → 404 comme l’absent (sales/audit non lus)', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(null);

    const err = await service
      .findOne(ORG_A, PRODUCT_ID, { kind: 'all' }, true)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as Error).message).toBe(`Product ${PRODUCT_ID} not found`);
    expect(saleModel.find).not.toHaveBeenCalled();
    expect(auditService.findByProduct).not.toHaveBeenCalled();
  });

  // ---- update ----

  it('update : relecture composite tenant, nom modifié, organisation jamais altérée, écriture atomique unique', async () => {
    await build();
    const doc = productDoc();
    productOneChain.exec.mockResolvedValue(doc);
    updateChain.exec.mockResolvedValue(productDoc({ name: 'Nouveau' }));

    const res = await service.update(
      ORG_A,
      PRODUCT_ID,
      { name: 'Nouveau' },
      'actor',
    );

    expect(productModel.findOne).toHaveBeenCalledWith({
      _id: PRODUCT_ID,
      organizationId: new Types.ObjectId(ORG_A),
    });
    // 1-15E : une seule écriture atomique, filtrée par tenant, `$set` des
    // seuls champs modifiés (jamais `organizationId` ni le stock).
    expect(doc.save).not.toHaveBeenCalled();
    expect(productModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(productModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: doc._id, organizationId: new Types.ObjectId(ORG_A) },
      { $set: { name: 'Nouveau' } },
      { returnDocument: 'after', runValidators: true },
    );
    expect(doc.organizationId).toEqual(new Types.ObjectId(ORG_A)); // inchangée
    expect(auditService.log).toHaveBeenCalled();
    expect(res.product.name).toBe('Nouveau');
    expect(eventsGateway.emitToOrganization).toHaveBeenCalledWith(
      ORG_A,
      'product:updated',
      expect.any(Object),
    );
    expect(s3Service.deleteStoredObject).not.toHaveBeenCalled();
  });

  it("update avec nouvelle photo : clé et stockage remplacés, ancienne supprimée APRÈS l'écriture, sort renvoyé", async () => {
    await build();
    const doc = productDoc();
    productOneChain.exec.mockResolvedValue(doc);
    updateChain.exec.mockResolvedValue(
      productDoc({ name: 'Nouveau', imageKey: IMAGE.key }),
    );

    const res = await service.update(
      ORG_A,
      PRODUCT_ID,
      { name: 'Nouveau' },
      'actor',
      IMAGE,
    );

    expect(productModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      { $set: { name: 'Nouveau', imageKey: IMAGE.key } },
      expect.any(Object),
    );
    // Ancienne photo supprimée APRÈS l'écriture réussie.
    expect(
      s3Service.deleteStoredObject.mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      productModel.findOneAndUpdate.mock.invocationCallOrder[0],
    );
    expect(s3Service.deleteStoredObject).toHaveBeenCalledTimes(1);
    expect(s3Service.deleteStoredObject).toHaveBeenCalledWith(
      { key: `${PREFIX_A}/p.jpg`, storage: STORAGE },
      PREFIX_A,
    );
    expect(res.product.imageUrl).toBe(`https://signed/${IMAGE.key}`);
    expect(res.storageCleanup).toBe('deleted');
  });

  it('update : échec de suppression de l’ancienne photo → mutation réussie, sort `failed` renvoyé (jamais « supprimée »)', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(productDoc());
    updateChain.exec.mockResolvedValue(productDoc({ imageKey: IMAGE.key }));
    s3Service.deleteStoredObject.mockResolvedValue('failed');
    const res = await service.update(ORG_A, PRODUCT_ID, {}, 'actor', IMAGE);
    expect(res.storageCleanup).toBe('failed');
  });

  it('update : ancienne URL (avant R2) conservée en base et jamais supprimée → `retained`', async () => {
    await build();
    const legacy = 'https://proj.supabase.co/storage/v1/object/public/b/x.png';
    const doc = productDoc({
      imageKey: null,
      imageStorage: null,
      imageUrl: legacy,
    });
    productOneChain.exec.mockResolvedValue(doc);
    updateChain.exec.mockResolvedValue(
      productDoc({ imageUrl: legacy, imageKey: IMAGE.key }),
    );
    const res = await service.update(ORG_A, PRODUCT_ID, {}, 'actor', IMAGE);
    const written = productModel.findOneAndUpdate.mock.calls[0][1] as {
      $set: Record<string, unknown>;
    };
    expect(written.$set).not.toHaveProperty('imageUrl');
    expect(s3Service.deleteStoredObject).not.toHaveBeenCalled();
    expect(res.storageCleanup).toBe('retained');
  });

  it('update sans photo : aucun nettoyage, aucun champ `storageCleanup`', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(productDoc());
    updateChain.exec.mockResolvedValue(productDoc({ name: 'N' }));
    const res = await service.update(ORG_A, PRODUCT_ID, { name: 'N' }, 'actor');
    expect(s3Service.deleteStoredObject).not.toHaveBeenCalled();
    expect(res).not.toHaveProperty('storageCleanup');
  });

  it('1-15E update : ajout de stock en `$inc` atomique, jamais en valeur absolue', async () => {
    await build();
    const doc = productDoc({ initialQuantity: 20, remainingQuantity: 15 });
    productOneChain.exec.mockResolvedValue(doc);
    updateChain.exec.mockResolvedValue(
      productDoc({ initialQuantity: 25, remainingQuantity: 18 }),
    );

    const res = await service.update(
      ORG_A,
      PRODUCT_ID,
      { additionalStock: 5, salePrice: 12 },
      'actor',
    );

    expect(productModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: doc._id, organizationId: new Types.ObjectId(ORG_A) },
      {
        $set: { salePrice: 12 },
        $inc: { initialQuantity: 5, remainingQuantity: 5 },
      },
      { returnDocument: 'after', runValidators: true },
    );
    // Le document lu n'est pas modifié pour le stock.
    expect(doc.initialQuantity).toBe(20);
    expect(doc.remainingQuantity).toBe(15);
    expect(auditService.log).toHaveBeenCalledWith(
      ORG_A,
      PRODUCT_ID,
      'stock_changed',
      'actor',
      { added: 5 },
    );
    // Réponse et émission : état ENREGISTRÉ (vente concurrente comprise).
    expect(res.product.remainingQuantity).toBe(18);
    expect(eventsGateway.emitToOrganization).toHaveBeenCalledWith(
      ORG_A,
      'product:updated',
      expect.objectContaining({
        product: expect.objectContaining({ remainingQuantity: 18 }),
      }),
    );
  });

  it('1-15E update : produit disparu à l’écriture → 404, aucune émission ni suppression d’image', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(productDoc());
    updateChain.exec.mockResolvedValue(null);

    const err = await service
      .update(ORG_A, PRODUCT_ID, { additionalStock: 5 }, 'actor', IMAGE)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(eventsGateway.emitToOrganization).not.toHaveBeenCalled();
    // L'ANCIENNE photo n'est jamais supprimée sans écriture réussie.
    expect(s3Service.deleteStoredObject).not.toHaveBeenCalled();
  });

  it('1-15E update : aucune modification → aucune écriture', async () => {
    await build();
    const doc = productDoc();
    productOneChain.exec.mockResolvedValue(doc);
    await service.update(ORG_A, PRODUCT_ID, { name: 'Prod' }, 'actor');
    expect(productModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('update : mouvement vers une section étrangère → 404 `Section`, rien sauvegardé', async () => {
    await build();
    const doc = productDoc();
    productOneChain.exec.mockResolvedValue(doc);
    sectionOneChain.exec.mockResolvedValue(null); // section cible non dans A

    const err = await service
      .update(ORG_A, PRODUCT_ID, { sectionId: FOREIGN_SECTION_ID }, 'actor')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as Error).message).toBe(
      `Section ${FOREIGN_SECTION_ID} not found`,
    );
    expect(sectionModel.findOne).toHaveBeenCalledWith({
      _id: new Types.ObjectId(FOREIGN_SECTION_ID),
      organizationId: new Types.ObjectId(ORG_A),
      deletedAt: null,
    });
    expect(doc.save).not.toHaveBeenCalled();
    expect(productModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('update : produit invisible → 404, aucune écriture', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(null);

    const err = await service
      .update(ORG_A, PRODUCT_ID, { name: 'X' }, 'actor')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
  });

  // ---- remove / restore / permanentDelete ----

  it('remove : filtre {_id, organizationId} + $set deletedAt ; invisible → 404', async () => {
    await build();
    updateChain.exec.mockResolvedValue(productDoc());
    await service.remove(ORG_A, PRODUCT_ID, 'actor');
    expect(eventsGateway.emitToOrganization).toHaveBeenCalledWith(
      ORG_A,
      'product:deleted',
      PRODUCT_ID,
    );
    expect(productModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: PRODUCT_ID, organizationId: new Types.ObjectId(ORG_A) },
      { $set: { deletedAt: expect.any(Date) } },
      { returnDocument: 'after' },
    );

    updateChain.exec.mockResolvedValue(null);
    const err = await service
      .remove(ORG_A, PRODUCT_ID, 'actor')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
  });

  it('1-15A : une émission en échec ne transforme jamais une mutation écrite en erreur', async () => {
    await build();
    eventsGateway.emitToOrganization.mockImplementation(() => {
      throw new Error('socket indisponible');
    });
    productOneChain.exec.mockResolvedValue(null);
    sectionOneChain.exec.mockResolvedValue(sectionDoc());
    countChain.exec.mockResolvedValue(0);
    productModel.create.mockResolvedValue(productDoc());
    await expect(
      service.create(ORG_A, DTO, IMAGE, 'actor'),
    ).resolves.toBeDefined();
    expect(productModel.create).toHaveBeenCalledTimes(1);

    updateChain.exec.mockResolvedValue(productDoc());
    await expect(
      service.remove(ORG_A, PRODUCT_ID, 'actor'),
    ).resolves.toBeDefined();
    await expect(service.restore(ORG_A, PRODUCT_ID)).resolves.toBeDefined();
    expect(eventsGateway.emitToOrganization).toHaveBeenCalledTimes(3);
  });

  it('restore : MÊME filtre + $set deletedAt:null ; invisible → 404', async () => {
    await build();
    updateChain.exec.mockResolvedValue(productDoc());
    await service.restore(ORG_A, PRODUCT_ID);
    expect(eventsGateway.emitToOrganization).toHaveBeenCalledWith(
      ORG_A,
      'product:created',
      expect.any(Object),
    );
    expect(productModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: PRODUCT_ID, organizationId: new Types.ObjectId(ORG_A) },
      { $set: { deletedAt: null } },
      { returnDocument: 'after' },
    );

    updateChain.exec.mockResolvedValue(null);
    const err = await service
      .restore(ORG_A, PRODUCT_ID)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
  });

  it('1-15B : suppression définitive → `product:purged` `{ _id }` seul, APRÈS la suppression ; distinct de la corbeille ; rien si rien n’est supprimé', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(productDoc());
    deleteChain.exec.mockResolvedValue(productDoc());
    await service.permanentDelete(ORG_A, PRODUCT_ID);
    expect(eventsGateway.emitToOrganization).toHaveBeenCalledTimes(1);
    expect(eventsGateway.emitToOrganization).toHaveBeenCalledWith(
      ORG_A,
      'product:purged',
      { _id: PRODUCT_ID },
    );
    expect(
      eventsGateway.emitToOrganization.mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      productModel.findOneAndDelete.mock.invocationCallOrder[0],
    );

    // Supprimé entre-temps par une autre requête : aucune émission.
    eventsGateway.emitToOrganization.mockClear();
    deleteChain.exec.mockResolvedValue(null);
    await service.permanentDelete(ORG_A, PRODUCT_ID);
    // Produit étranger ou absent : 404 sans émission.
    productOneChain.exec.mockResolvedValue(null);
    await service.permanentDelete(ORG_A, PRODUCT_ID).catch(() => undefined);
    expect(eventsGateway.emitToOrganization).not.toHaveBeenCalled();

    // Panne d'émission : la suppression déjà faite reste un succès.
    productOneChain.exec.mockResolvedValue(productDoc());
    deleteChain.exec.mockResolvedValue(productDoc());
    eventsGateway.emitToOrganization.mockImplementation(() => {
      throw new Error('socket indisponible');
    });
    await expect(
      service.permanentDelete(ORG_A, PRODUCT_ID),
    ).resolves.toBeDefined();
  });

  it('permanentDelete : purge {_id, organizationId} PUIS suppression du fichier, hors transaction', async () => {
    await build();
    const doc = productDoc();
    productOneChain.exec.mockResolvedValue(doc);
    deleteChain.exec.mockResolvedValue(doc);

    const res = await service.permanentDelete(ORG_A, PRODUCT_ID);
    // 1-12H : réponse projetée (visibilité standard par défaut).
    expect(res).toMatchObject({
      _id: PRODUCT_ID,
      name: 'Prod',
      imageUrl: null,
      storageCleanup: 'deleted',
    });
    expect(res).not.toHaveProperty('purchasePrice');
    expect(productModel.findOneAndDelete).toHaveBeenCalledWith(
      { _id: PRODUCT_ID, organizationId: new Types.ObjectId(ORG_A) },
      { session: tx.session },
    );
    expect(s3Service.deleteStoredObject).toHaveBeenCalledTimes(1);
    expect(s3Service.deleteStoredObject).toHaveBeenCalledWith(
      { key: `${PREFIX_A}/p.jpg`, storage: STORAGE },
      PREFIX_A,
    );
    // Fichier supprimé APRÈS le commit, HORS de la transaction.
    expect(
      s3Service.deleteStoredObject.mock.invocationCallOrder[0],
    ).toBeGreaterThan(tx.session.endSession.mock.invocationCallOrder[0]);
  });

  it('permanentDelete : échec de suppression du fichier → produit purgé, `failed` renvoyé', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(productDoc());
    deleteChain.exec.mockResolvedValue(productDoc());
    s3Service.deleteStoredObject.mockResolvedValue('failed');
    const res = await service.permanentDelete(ORG_A, PRODUCT_ID);
    expect(res.storageCleanup).toBe('failed');
    expect(eventsGateway.emitToOrganization).toHaveBeenCalledWith(
      ORG_A,
      'product:purged',
      { _id: PRODUCT_ID },
    );
  });

  it('permanentDelete : ancienne URL → jamais supprimée (`retained`) ; déjà purgé ailleurs → `not_needed`', async () => {
    await build();
    const legacy = productDoc({
      imageKey: null,
      imageStorage: null,
      imageUrl: 'https://proj.supabase.co/storage/v1/object/public/b/x.png',
    });
    productOneChain.exec.mockResolvedValue(legacy);
    deleteChain.exec.mockResolvedValue(legacy);
    expect(
      (await service.permanentDelete(ORG_A, PRODUCT_ID)).storageCleanup,
    ).toBe('retained');
    expect(s3Service.deleteStoredObject).not.toHaveBeenCalled();

    productOneChain.exec.mockResolvedValue(productDoc());
    deleteChain.exec.mockResolvedValue(null);
    expect(
      (await service.permanentDelete(ORG_A, PRODUCT_ID)).storageCleanup,
    ).toBe('not_needed');
    expect(s3Service.deleteStoredObject).not.toHaveBeenCalled();
  });

  it('1-15D : purge → historique figé sur les ventes du produit, dans la MÊME transaction', async () => {
    await build();
    const doc = productDoc({ name: 'Nom final', purchasePrice: 7 });
    productOneChain.exec.mockResolvedValue(doc);
    deleteChain.exec.mockResolvedValue(doc);

    await service.permanentDelete(ORG_A, PRODUCT_ID);
    expect(saleModel.updateMany).toHaveBeenCalledTimes(1);
    expect(saleModel.updateMany).toHaveBeenCalledWith(
      {
        organizationId: new Types.ObjectId(ORG_A),
        productId: doc._id,
        // Idempotent : jamais d'écrasement d'un historique déjà posé.
        lastKnownSource: { $exists: false },
      },
      {
        $set: {
          lastKnownProductName: 'Nom final',
          lastKnownUnitCost: 7,
          lastKnownSource: 'purge',
        },
      },
      { session: tx.session },
    );
    // `productName` (nom enregistré à la vente) n'est jamais réécrit.
    const [, update] = saleModel.updateMany.mock.calls[0] as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(update.$set).not.toHaveProperty('productName');
    // Ordre : suppression du document puis historique ; émission après.
    expect(
      productModel.findOneAndDelete.mock.invocationCallOrder[0],
    ).toBeLessThan(saleModel.updateMany.mock.invocationCallOrder[0]);
    expect(
      eventsGateway.emitToOrganization.mock.invocationCallOrder[0],
    ).toBeGreaterThan(tx.session.withTransaction.mock.invocationCallOrder[0]);
  });

  it('1-15D : document déjà supprimé par une autre requête → aucun historique réécrit ni émission', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(productDoc());
    deleteChain.exec.mockResolvedValue(null);
    await service.permanentDelete(ORG_A, PRODUCT_ID);
    expect(saleModel.updateMany).not.toHaveBeenCalled();
    expect(eventsGateway.emitToOrganization).not.toHaveBeenCalled();
  });

  it('1-15D : stock et ventes concordants → aucun écart figé', async () => {
    await build();
    const doc = productDoc({ initialQuantity: 10, remainingQuantity: 7 });
    productOneChain.exec.mockResolvedValue(doc);
    deleteChain.exec.mockResolvedValue(doc);
    aggregateChain.exec.mockResolvedValue([{ units: 3 }]);
    await service.permanentDelete(ORG_A, PRODUCT_ID);
    expect(saleModel.aggregate).toHaveBeenCalledWith([
      {
        $match: {
          organizationId: new Types.ObjectId(ORG_A),
          productId: doc._id,
        },
      },
      { $group: { _id: null, units: { $sum: '$quantity' } } },
    ]);
    expect(aggregateChain.session).toHaveBeenCalledWith(tx.session);
    expect(stockAdjustmentModel.create).not.toHaveBeenCalled();
  });

  it('1-15D : stock et ventes divergents → écart figé dans la MÊME transaction', async () => {
    await build();
    const doc = productDoc({
      initialQuantity: 25,
      remainingQuantity: 23,
      purchasePrice: 7,
    });
    productOneChain.exec.mockResolvedValue(doc);
    deleteChain.exec.mockResolvedValue(doc);
    aggregateChain.exec.mockResolvedValue([{ units: 5 }]);
    await service.permanentDelete(ORG_A, PRODUCT_ID);
    expect(stockAdjustmentModel.create).toHaveBeenCalledWith(
      [
        {
          organizationId: new Types.ObjectId(ORG_A),
          productId: doc._id,
          unitCost: 7,
          units: -3,
        },
      ],
      { session: tx.session },
    );
  });

  it('1-15D : échec de la transaction → erreur propagée, session fermée, aucune émission', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(productDoc());
    deleteChain.exec.mockResolvedValue(productDoc());
    updateManyChain.exec.mockRejectedValue(new Error('écriture refusée'));
    await expect(service.permanentDelete(ORG_A, PRODUCT_ID)).rejects.toThrow(
      'écriture refusée',
    );
    expect(tx.session.endSession).toHaveBeenCalledTimes(1);
    expect(eventsGateway.emitToOrganization).not.toHaveBeenCalled();
    // MongoDB en échec : le fichier n'est JAMAIS supprimé.
    expect(s3Service.deleteStoredObject).not.toHaveBeenCalled();
  });

  it('permanentDelete : produit étranger → 404, aucun fichier touché, pas de purge', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(null);

    const err = await service
      .permanentDelete(ORG_A, PRODUCT_ID)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(s3Service.deleteStoredObject).not.toHaveBeenCalled();
    expect(productModel.findOneAndDelete).not.toHaveBeenCalled();
    expect(tx.connection.startSession).not.toHaveBeenCalled();
    expect(saleModel.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * 1-4C.1 — cas 15 : les 6 `AuditService.log` des chemins Produit existants
 * (`create`, 5 `update`, `remove`) transmettent TOUS leur `organizationId`
 * comme PREMIER argument. Sans ce changement, le service ne compile plus :
 * la nouvelle signature d'`AuditService.log` l'exige.
 */
describe('ProductsService — appelants AuditService.log portent la tenant (1-4C.1)', () => {
  let service: ProductsService;
  let productModel: {
    create: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
  };
  let sectionModel: { findOne: jest.Mock; countDocuments: jest.Mock };
  let auditService: { log: jest.Mock; findByProduct: jest.Mock };
  let productOneChain: { exec: jest.Mock };
  let sectionOneChain: { exec: jest.Mock };
  let countChain: { exec: jest.Mock };
  let updateChain: { exec: jest.Mock };
  let findChain: { sort: jest.Mock; exec: jest.Mock };

  const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const SECTION_ID = '112233445566778899001122';
  const PRODUCT_ID = '223344556677889900112233';

  function sectionDoc() {
    return {
      _id: new Types.ObjectId(SECTION_ID),
      name: 'Sec',
      deletedAt: null,
      organizationId: new Types.ObjectId(ORG_A),
    };
  }

  function productDoc(overrides: Record<string, unknown> = {}) {
    const doc: Record<string, unknown> = {
      _id: new Types.ObjectId(PRODUCT_ID),
      sectionId: new Types.ObjectId(SECTION_ID),
      name: 'Prod',
      imageKey: `organizations/${ORG_A}/products/p.jpg`,
      imageStorage: 'r2/stockmaster-prod',
      purchasePrice: 5,
      salePrice: 10,
      initialQuantity: 10,
      remainingQuantity: 10,
      deletedAt: null,
      organizationId: new Types.ObjectId(ORG_A),
      save: jest.fn(),
      ...overrides,
    };
    (doc.save as jest.Mock).mockResolvedValue(doc);
    trackChanges(doc);
    return doc;
  }

  async function build() {
    findChain = { sort: jest.fn(), exec: jest.fn() };
    findChain.sort.mockReturnValue(findChain);
    updateChain = { exec: jest.fn() };
    productOneChain = { exec: jest.fn() };
    sectionOneChain = { exec: jest.fn() };
    countChain = { exec: jest.fn() };
    productModel = {
      create: jest.fn(),
      find: jest.fn(() => findChain),
      findOne: jest.fn(() => productOneChain),
      findOneAndUpdate: jest.fn(() => updateChain),
    };
    sectionModel = {
      findOne: jest.fn(() => sectionOneChain),
      countDocuments: jest.fn(() => countChain),
    };
    auditService = { log: jest.fn(), findByProduct: jest.fn() };
    auditService.findByProduct.mockResolvedValue([]);
    const saleChain = {
      populate: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: getModelToken(Product.name), useValue: productModel },
        {
          provide: getModelToken(PurgedStockAdjustment.name),
          useValue: {},
        },
        {
          provide: getModelToken(Sale.name),
          useValue: { find: jest.fn(() => saleChain) },
        },
        {
          provide: getModelToken(Section.name),
          useValue: sectionModel,
        },
        {
          provide: S3Service,
          useValue: {
            signedReadUrl: jest.fn().mockResolvedValue(null),
            deleteStoredObject: jest.fn(),
          },
        },
        {
          provide: EventsGateway,
          useValue: { emitToOrganization: jest.fn() },
        },
        { provide: AuditService, useValue: auditService },
        {
          provide: getConnectionToken(),
          useValue: makeConnection().connection,
        },
      ],
    }).compile();
    service = module.get(ProductsService);
  }

  it('create : AuditService.log reçoit l’org SERVEUR en 1er argument', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(null);
    sectionOneChain.exec.mockResolvedValue(sectionDoc());
    countChain.exec.mockResolvedValue(0);
    productModel.create.mockResolvedValue(productDoc());

    const DTO = {
      sectionId: SECTION_ID,
      name: 'Prod',
      purchasePrice: 5,
      salePrice: 10,
      initialQuantity: 7,
    };
    await service.create(
      ORG_A,
      DTO,
      { key: `organizations/${ORG_A}/products/n.jpg`, storage: 'r2/b' },
      'actor',
    );
    expect(auditService.log).toHaveBeenCalledTimes(1);
    const [orgArg] = auditService.log.mock.calls[0] as unknown[];
    expect(orgArg).toBe(ORG_A);
  });

  it('update : les 3 audits (NAME/PRICE/SECTION) reçoivent l’org en 1er argument', async () => {
    await build();
    const doc = productDoc();
    productOneChain.exec.mockResolvedValue(doc);
    updateChain.exec.mockResolvedValue(doc);
    sectionOneChain.exec.mockResolvedValue(sectionDoc());
    // 3 changes distinctes : name, price, section.
    await service.update(
      ORG_A,
      PRODUCT_ID,
      { name: 'N', purchasePrice: 20, salePrice: 30, sectionId: SECTION_ID },
      'actor',
    );
    // NAME_CHANGED + PRICE_CHANGED (+ SECTION_CHANGED si org diff) → au moins 2 audits :
    expect(auditService.log.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of auditService.log.mock.calls as unknown[][]) {
      expect(call[0]).toBe(ORG_A);
    }
  });

  it('remove : AuditService.log reçoit l’org en 1er argument', async () => {
    await build();
    updateChain.exec.mockResolvedValue(productDoc());
    await service.remove(ORG_A, PRODUCT_ID, 'actor');
    expect(auditService.log).toHaveBeenCalledTimes(1);
    const [orgArg] = auditService.log.mock.calls[0] as unknown[];
    expect(orgArg).toBe(ORG_A);
  });
});

describe('ProductsService.adjustStock — tenant et session (1-4C.2)', () => {
  let service: ProductsService;
  let productModel: { findOne: jest.Mock };
  let findChain: { exec: jest.Mock };

  beforeEach(async () => {
    findChain = { exec: jest.fn() };
    productModel = { findOne: jest.fn(() => findChain) };
    const module = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: getModelToken(Product.name), useValue: productModel },
        {
          provide: getModelToken(PurgedStockAdjustment.name),
          useValue: {},
        },
        { provide: getModelToken(Sale.name), useValue: {} },
        { provide: getModelToken(Section.name), useValue: {} },
        { provide: S3Service, useValue: {} },
        { provide: EventsGateway, useValue: {} },
        { provide: AuditService, useValue: {} },
        {
          provide: getConnectionToken(),
          useValue: makeConnection().connection,
        },
      ],
    }).compile();
    service = module.get(ProductsService);
  });

  it('filtre par produit + tenant et utilise la même session pour lire et sauvegarder', async () => {
    const session = makeSession();
    const product = {
      remainingQuantity: 4,
      deletedAt: new Date(),
      save: jest.fn().mockResolvedValue(undefined),
    };
    findChain.exec.mockResolvedValue(product);

    await service.adjustStock(TRADE_ORG_A, PRODUCT_OBJECT_ID, 2, session);

    expect(productModel.findOne).toHaveBeenCalledWith(
      {
        _id: new Types.ObjectId(PRODUCT_OBJECT_ID),
        organizationId: new Types.ObjectId(TRADE_ORG_A),
      },
      null,
      { session },
    );
    expect(product.remainingQuantity).toBe(6);
    expect(product.save).toHaveBeenCalledWith({ session });
  });

  it('produit absent ou étranger retourne sans écriture comme avant', async () => {
    findChain.exec.mockResolvedValue(null);

    await expect(
      service.adjustStock(TRADE_ORG_A, UNKNOWN_PRODUCT_ID, 2),
    ).resolves.toBeUndefined();
  });

  it('stock négatif conserve le message exact et ne sauvegarde pas', async () => {
    const product = {
      remainingQuantity: 1,
      save: jest.fn().mockResolvedValue(undefined),
    };
    findChain.exec.mockResolvedValue(product);

    await expect(
      service.adjustStock(TRADE_ORG_A, PRODUCT_OBJECT_ID, -2),
    ).rejects.toThrow('Insufficient stock. Available: 1');
    expect(product.save).not.toHaveBeenCalled();
  });
});
