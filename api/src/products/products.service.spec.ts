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
  let saleModel: { find: jest.Mock };
  let s3Service: { deleteFile: jest.Mock; uploadFile: jest.Mock };
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
      imageUrl: 'http://s3-e2e/p.png',
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
    saleModel = { find: jest.fn(() => saleChain) };
    s3Service = { deleteFile: jest.fn(), uploadFile: jest.fn() };
    auditService = { log: jest.fn(), findByProduct: jest.fn() };
    auditService.findByProduct.mockResolvedValue([]);
    eventsGateway = { emitToOrganization: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: getModelToken(Product.name), useValue: productModel },
        { provide: getModelToken(Sale.name), useValue: saleModel },
        { provide: getModelToken(Section.name), useValue: sectionModel },
        { provide: S3Service, useValue: s3Service },
        { provide: EventsGateway, useValue: eventsGateway },
        { provide: AuditService, useValue: auditService },
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
    await service.create(ORG_A, dto, 'http://s3/x.png', 'actor');

    const written = productModel.create.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(String(written.organizationId)).toBe(ORG_A); // jamais B
    expect(String(written.imageUrl)).toBe('http://s3/x.png');
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
      .create(ORG_A, DTO, 'http://s3/x.png', 'actor')
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
      .create(ORG_A, DTO, 'http://s3/x.png', 'actor')
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
    expect(res.actualRevenue).toBe(0);
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

  it('update : relecture composite tenant, nom modifié, organisation jamais altérée, save unique', async () => {
    await build();
    const doc = productDoc();
    productOneChain.exec.mockResolvedValue(doc);

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
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(doc.name).toBe('Nouveau');
    expect(doc.organizationId).toEqual(new Types.ObjectId(ORG_A)); // inchangée
    expect(auditService.log).toHaveBeenCalled();
    expect(res.product.name).toBe('Nouveau');
    expect(eventsGateway.emitToOrganization).toHaveBeenCalledWith(
      ORG_A,
      'product:updated',
      expect.any(Object),
    );
    expect(s3Service.deleteFile).not.toHaveBeenCalled();
  });

  it("update avec newImageUrl : remplace imageUrl et supprime l'ancienne APRÈS save, sous le préfixe de l'org", async () => {
    await build();
    const doc = productDoc();
    const previousImageUrl = doc.imageUrl as string;
    productOneChain.exec.mockResolvedValue(doc);

    const res = await service.update(
      ORG_A,
      PRODUCT_ID,
      { name: 'Nouveau' },
      'actor',
      'http://s3-e2e/new.png',
    );

    expect(doc.imageUrl).toBe('http://s3-e2e/new.png');
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(s3Service.deleteFile).toHaveBeenCalledTimes(1);
    expect(s3Service.deleteFile).toHaveBeenCalledWith(
      previousImageUrl,
      `organizations/${ORG_A}/products`,
    );
    expect(res.product.imageUrl).toBe('http://s3-e2e/new.png');
  });

  it("update avec newImageUrl identique à l'existante : aucune suppression S3", async () => {
    await build();
    const doc = productDoc({ imageUrl: 'http://s3-e2e/same.png' });
    productOneChain.exec.mockResolvedValue(doc);

    await service.update(
      ORG_A,
      PRODUCT_ID,
      { name: 'Nouveau' },
      'actor',
      'http://s3-e2e/same.png',
    );

    expect(s3Service.deleteFile).not.toHaveBeenCalled();
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

  it('permanentDelete : S3 deleteFile puis purge {_id, organizationId} UNIQUEMENT', async () => {
    await build();
    const doc = productDoc();
    productOneChain.exec.mockResolvedValue(doc); // porte imageUrl
    deleteChain.exec.mockResolvedValue(doc);

    const res = await service.permanentDelete(ORG_A, PRODUCT_ID);
    expect(res).toBe(doc);
    expect(s3Service.deleteFile).toHaveBeenCalledTimes(1);
    expect(s3Service.deleteFile).toHaveBeenCalledWith(
      doc.imageUrl,
      `organizations/${ORG_A}/products`,
    );
    expect(productModel.findOneAndDelete).toHaveBeenCalledWith({
      _id: PRODUCT_ID,
      organizationId: new Types.ObjectId(ORG_A),
    });
  });

  it('permanentDelete : produit étranger → 404, S3 deleteFile JAMAIS appelé, pas de purge', async () => {
    await build();
    productOneChain.exec.mockResolvedValue(null);

    const err = await service
      .permanentDelete(ORG_A, PRODUCT_ID)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(s3Service.deleteFile).not.toHaveBeenCalled();
    expect(productModel.findOneAndDelete).not.toHaveBeenCalled();
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
      imageUrl: 'http://s3-e2e/p.png',
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
          provide: getModelToken(Sale.name),
          useValue: { find: jest.fn(() => saleChain) },
        },
        {
          provide: getModelToken(Section.name),
          useValue: sectionModel,
        },
        {
          provide: S3Service,
          useValue: { deleteFile: jest.fn(), uploadFile: jest.fn() },
        },
        {
          provide: EventsGateway,
          useValue: { emitToOrganization: jest.fn() },
        },
        { provide: AuditService, useValue: auditService },
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
    await service.create(ORG_A, DTO, 'http://s3/x.png', 'actor');
    expect(auditService.log).toHaveBeenCalledTimes(1);
    const [orgArg] = auditService.log.mock.calls[0] as unknown[];
    expect(orgArg).toBe(ORG_A);
  });

  it('update : les 3 audits (NAME/PRICE/SECTION) reçoivent l’org en 1er argument', async () => {
    await build();
    const doc = productDoc();
    productOneChain.exec.mockResolvedValue(doc);
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
        { provide: getModelToken(Sale.name), useValue: {} },
        { provide: getModelToken(Section.name), useValue: {} },
        { provide: S3Service, useValue: {} },
        { provide: EventsGateway, useValue: {} },
        { provide: AuditService, useValue: {} },
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
