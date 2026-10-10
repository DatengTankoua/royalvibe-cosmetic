import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import sharp from 'sharp';
import { PRODUCT_IDS_MAX, ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { StorageQuotaService } from '../storage-quota/storage-quota.service';
import { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { OrganizationRole } from '../organizations/permissions';
import type { User } from '../users/schemas/user.schema';
import { PushOutboxService } from '../push/push-outbox.service';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PRODUCT_ID = '223344556677889900112233';
const SECTION_QUERY = '112233445566778899001122';
// 1-12H : visibilité produit calculée par le contrôleur depuis le contexte.
const FULL = { stockDetails: true, financials: true };
const STANDARD = { stockDetails: false, financials: false };

/**
 * Le contexte est celui BRANCHÉ par `OrganizationGuard` sur `request` :
 * seul le `@CurrentOrganization()` du contrôleur peut le produire ici —
 * aucun paramètre du client n'est impliqué.
 */
function makeContext(
  org: string,
  role: OrganizationRole = OrganizationRole.OWNER,
  permissions: ResolvedOrganizationContext['permissions'] = ['catalog.manage'],
): ResolvedOrganizationContext {
  return {
    userId: '111111111111111111111111',
    organizationId: org,
    membershipId: '222222222222222222222222',
    role,
    permissions,
  };
}

const user = { _id: new Types.ObjectId('eeeeeeeeeeeeeeeeeeeeeeee') } as User;
const PREFIX_A = `organizations/${ORG_A}/products`;
const STORED = { key: `${PREFIX_A}/new.png`, storage: 'r2/stockmaster-prod' };

// Vraie photo PNG (contrôlée par Sharp) ; une copie par appel : le
// contrôleur libère le contenu reçu après l'envoi.
let PNG: Buffer;
beforeAll(async () => {
  PNG = await sharp({
    create: { width: 4, height: 4, channels: 3, background: '#f80' },
  })
    .png()
    .toBuffer();
});
function imageFile(): Express.Multer.File {
  return {
    buffer: Buffer.from(PNG),
    size: PNG.length,
    originalname: 'a.png',
    mimetype: 'image/png',
  } as Express.Multer.File;
}

/**
 * ProductsController (1-4B) — chaque route du catalogue transmet EXACTEMENT
 * `organizationContext.organizationId` comme premier argument au service :
 * jamais une valeur issue du body, de la query ou des headers.
 */
describe('ProductsController — transmission du tenant (1-4B)', () => {
  let controller: ProductsController;

  const serviceStub = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    restore: jest.fn(),
    remove: jest.fn(),
    permanentDelete: jest.fn(),
    isImageReferenced: jest.fn(),
  };

  const s3Stub = {
    uploadValidatedImage: jest.fn().mockResolvedValue(STORED),
    deleteStoredObject: jest.fn().mockResolvedValue('deleted'),
  };

  // 1-17B : la réservation et la comptabilisation sont couvertes par
  // `storage-quota.service.spec` ; ici, `store` envoie via le stockage
  // simulé (même préfixe) et `discard` est observé.
  // 1-19A : activité des membres (outbox), espionnée.
  const outboxStub = { memberActivity: jest.fn() };

  const quotaStub = {
    store: jest.fn(
      (input: {
        organizationId: string;
        body: Buffer;
        image: Record<string, string>;
      }) =>
        s3Stub.uploadValidatedImage(
          input.body,
          `organizations/${input.organizationId}/products`,
          input.image,
        ) as Promise<unknown>,
    ),
    discard: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    for (const key of Object.keys(serviceStub)) {
      serviceStub[key].mockReset();
      // 1-19A : vue produit (et vue métriques) renvoyées par le service.
      serviceStub[key].mockResolvedValue({
        _id: 'product-1',
        name: 'Savon',
        product: { _id: 'product-1', name: 'Savon' },
      });
    }
    // `findOne` retourne toujours un `ProductDetail` réaliste (1-7B : le
    // contrôleur lit `result.auditLogs` pour appliquer le gate `audit.read`).
    serviceStub.findOne.mockResolvedValue({
      product: {},
      auditLogs: [{ action: 'created' }],
    });
    serviceStub.isImageReferenced.mockResolvedValue(false);
    s3Stub.uploadValidatedImage.mockReset().mockResolvedValue(STORED);
    s3Stub.deleteStoredObject.mockReset().mockResolvedValue('deleted');
    quotaStub.store.mockClear();
    outboxStub.memberActivity.mockReset().mockResolvedValue(undefined);
    quotaStub.discard.mockClear();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProductsController],
      providers: [
        { provide: ProductsService, useValue: serviceStub },
        { provide: StorageQuotaService, useValue: quotaStub },
        { provide: PushOutboxService, useValue: outboxStub },
      ],
    }).compile();
    controller = module.get(ProductsController);
  });

  const ctxA = makeContext(ORG_A);
  const actorId = 'eeeeeeeeeeeeeeeeeeeeeeee';

  it('create : photo contrôlée puis envoyée sous le préfixe de l’org ; transmet org, DTO, référence et actorId', async () => {
    const dto = {
      sectionId: SECTION_QUERY,
      name: 'N',
      purchasePrice: 5,
      salePrice: 10,
      initialQuantity: 7,
    };
    const file = imageFile();
    await controller.create(dto, file, user, ctxA);
    expect(s3Stub.uploadValidatedImage).toHaveBeenCalledTimes(1);
    expect(s3Stub.uploadValidatedImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      PREFIX_A,
      { format: 'png', extension: 'png', contentType: 'image/png' },
    );
    // Contenu reçu libéré après l'envoi.
    expect(file.buffer.length).toBe(0);
    expect(serviceStub.create).toHaveBeenCalledTimes(1);
    expect(serviceStub.create).toHaveBeenCalledWith(
      ORG_A,
      dto,
      STORED,
      actorId,
      FULL,
    );
    expect(s3Stub.deleteStoredObject).not.toHaveBeenCalled();
    // 1-19A : création réussie annoncée APRÈS le service (nom figé).
    expect(outboxStub.memberActivity).toHaveBeenCalledWith(ctxA, {
      entity: 'product',
      action: 'created',
      targetId: 'product-1',
      targetName: 'Savon',
      uniqueKey: undefined,
    });
    expect(
      outboxStub.memberActivity.mock.invocationCallOrder[0],
    ).toBeGreaterThan(serviceStub.create.mock.invocationCallOrder[0]);
  });

  it('create : photo invalide (texte déguisé en PNG) → 400 avant tout envoi ni écriture', async () => {
    const dto = {
      sectionId: SECTION_QUERY,
      name: 'N',
      purchasePrice: 5,
      salePrice: 10,
      initialQuantity: 7,
    };
    const fake = {
      buffer: Buffer.from('<svg onload=alert(1)>'),
      size: 21,
      originalname: 'a.png',
      mimetype: 'image/png',
    } as Express.Multer.File;
    await expect(controller.create(dto, fake, user, ctxA)).rejects.toThrow(
      BadRequestException,
    );
    expect(s3Stub.uploadValidatedImage).not.toHaveBeenCalled();
    expect(serviceStub.create).not.toHaveBeenCalled();
  });

  it('create : écriture MongoDB échouée après upload → nouvelle photo abandonnée (supprimée si non référencée), erreur repropagée', async () => {
    const dto = {
      sectionId: SECTION_QUERY,
      name: 'N',
      purchasePrice: 5,
      salePrice: 10,
      initialQuantity: 7,
    };
    const error = new Error('create failed');
    serviceStub.create.mockRejectedValueOnce(error);
    await expect(controller.create(dto, imageFile(), user, ctxA)).rejects.toBe(
      error,
    );
    // Vérification de référence, suppression et libération : `discard`.
    expect(quotaStub.discard).toHaveBeenCalledTimes(1);
    expect(quotaStub.discard).toHaveBeenCalledWith(STORED);
    // 1-19A : aucune activité annoncée pour une création échouée.
    expect(outboxStub.memberActivity).not.toHaveBeenCalled();
  });

  it('1-17B create : réservation refusée (quota) → aucune écriture, erreur repropagée', async () => {
    const dto = {
      sectionId: SECTION_QUERY,
      name: 'N',
      purchasePrice: 5,
      salePrice: 10,
      initialQuantity: 7,
    };
    const quota = Object.assign(new Error('quota'), { status: 413 });
    quotaStub.store.mockRejectedValueOnce(quota);
    await expect(controller.create(dto, imageFile(), user, ctxA)).rejects.toBe(
      quota,
    );
    expect(serviceStub.create).not.toHaveBeenCalled();
    expect(quotaStub.discard).not.toHaveBeenCalled();
  });

  it('create : envoi échoué → aucune écriture ni suppression, erreur repropagée', async () => {
    const dto = {
      sectionId: SECTION_QUERY,
      name: 'N',
      purchasePrice: 5,
      salePrice: 10,
      initialQuantity: 7,
    };
    const error = new Error('upload failed');
    s3Stub.uploadValidatedImage.mockReset().mockRejectedValueOnce(error);
    await expect(controller.create(dto, imageFile(), user, ctxA)).rejects.toBe(
      error,
    );
    expect(serviceStub.create).not.toHaveBeenCalled();
    expect(s3Stub.deleteStoredObject).not.toHaveBeenCalled();
  });

  it('findAll : transmet l’org du contexte + sectionId de la query inchangée', async () => {
    await controller.findAll(SECTION_QUERY, undefined, ctxA);
    expect(serviceStub.findAll).toHaveBeenCalledTimes(1);
    expect(serviceStub.findAll).toHaveBeenCalledWith(
      ORG_A,
      SECTION_QUERY,
      FULL,
      undefined,
    );

    await controller.findAll(undefined, undefined, ctxA);
    expect(serviceStub.findAll).toHaveBeenCalledWith(
      ORG_A,
      undefined,
      FULL,
      undefined,
    );
  });

  describe('findAll — relecture ciblée `ids` (1-20D)', () => {
    const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

    it('identifiants distincts transmis, avec l’org du contexte et la projection', async () => {
      await controller.findAll(SECTION_QUERY, `${A},${B},${A}`, ctxA);
      expect(serviceStub.findAll).toHaveBeenLastCalledWith(
        ORG_A,
        SECTION_QUERY,
        FULL,
        [A, B],
      );
    });

    it('projection selon les permissions du demandeur (vendeur : champs standard)', async () => {
      await controller.findAll(
        undefined,
        A,
        makeContext(ORG_A, OrganizationRole.SELLER, []),
      );
      expect(serviceStub.findAll).toHaveBeenLastCalledWith(
        ORG_A,
        undefined,
        STANDARD,
        [A],
      );
    });

    it.each([
      ['vide', ''],
      ['identifiant invalide', `${A},nope`],
      ['tableau (paramètre répété)', [A, B]],
      [
        'plus de PRODUCT_IDS_MAX',
        Array.from({ length: PRODUCT_IDS_MAX + 1 }, (_, i) =>
          i.toString(16).padStart(24, '0'),
        ).join(','),
      ],
    ])('%s → 400, service jamais appelé', async (_label, ids) => {
      serviceStub.findAll.mockClear();
      await expect(
        Promise.resolve().then(() => controller.findAll(undefined, ids, ctxA)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(serviceStub.findAll).not.toHaveBeenCalled();
    });
  });

  it('findOne : transmet l’org du contexte + l’id du paramètre + le scope calculé', async () => {
    await controller.findOne(PRODUCT_ID, ctxA);
    expect(serviceStub.findOne).toHaveBeenCalledWith(
      ORG_A,
      PRODUCT_ID,
      { kind: 'all' },
      true,
      FULL,
    );
  });

  describe('visibilité produit (1-12H) : groupes indépendants, jamais depuis User.role', () => {
    it.each([
      ['seller sans délégation', [], STANDARD],
      [
        'seller + détail du stock',
        ['products.view_stock_details'],
        { stockDetails: true, financials: false },
      ],
      [
        'seller + finances',
        ['products.view_financials'],
        { stockDetails: false, financials: true },
      ],
      [
        'seller + deux groupes',
        ['products.view_stock_details', 'products.view_financials'],
        FULL,
      ],
      ['seller + sales.view_all seul', ['sales.view_all'], STANDARD],
      ['seller + analytics.read seul', ['analytics.read'], STANDARD],
    ] as const)('%s', async (_label, permissions, expected) => {
      const ctx = makeContext(ORG_A, OrganizationRole.SELLER, [...permissions]);
      await controller.findAll(undefined, undefined, ctx);
      expect(serviceStub.findAll).toHaveBeenLastCalledWith(
        ORG_A,
        undefined,
        expected,
        undefined,
      );
    });

    it('admin : les deux groupes par défaut', async () => {
      await controller.findAll(
        undefined,
        undefined,
        makeContext(ORG_A, OrganizationRole.ADMIN, []),
      );
      expect(serviceStub.findAll).toHaveBeenLastCalledWith(
        ORG_A,
        undefined,
        FULL,
        undefined,
      );
    });
  });

  describe('findOne — scope ventes + gate audit.read (1-7B correctif : jamais interrogé hors scope)', () => {
    it('owner/admin (défaut) : scope ventes «all» + audit.read inclus', async () => {
      await controller.findOne(PRODUCT_ID, ctxA);
      expect(serviceStub.findOne).toHaveBeenCalledWith(
        ORG_A,
        PRODUCT_ID,
        { kind: 'all' },
        true,
        FULL,
      );
    });

    it('seller sans délégation (défaut) : scope «own» (sellerId = userId du contexte), audit exclu', async () => {
      const sellerCtx = makeContext(ORG_A, OrganizationRole.SELLER, []);
      await controller.findOne(PRODUCT_ID, sellerCtx);
      expect(serviceStub.findOne).toHaveBeenCalledWith(
        ORG_A,
        PRODUCT_ID,
        { kind: 'own', sellerId: sellerCtx.userId },
        false,
        STANDARD,
      );
    });

    it('seller délégué sales.view_all : scope «all»', async () => {
      const sellerCtx = makeContext(ORG_A, OrganizationRole.SELLER, [
        'sales.view_all',
      ]);
      await controller.findOne(PRODUCT_ID, sellerCtx);
      expect(serviceStub.findOne).toHaveBeenCalledWith(
        ORG_A,
        PRODUCT_ID,
        { kind: 'all' },
        false,
        STANDARD,
      );
    });

    it('seller délégué audit.read : audit inclus, scope ventes toujours «own»', async () => {
      const sellerCtx = makeContext(ORG_A, OrganizationRole.SELLER, [
        'audit.read',
      ]);
      await controller.findOne(PRODUCT_ID, sellerCtx);
      expect(serviceStub.findOne).toHaveBeenCalledWith(
        ORG_A,
        PRODUCT_ID,
        { kind: 'own', sellerId: sellerCtx.userId },
        true,
        STANDARD,
      );
    });

    it('rôle hors table (1-12H) : droits standard → scope «own», jamais «all»', async () => {
      const noScopeCtx = makeContext(
        ORG_A,
        'guest' as unknown as OrganizationRole,
        [],
      );
      await controller.findOne(PRODUCT_ID, noScopeCtx);
      expect(serviceStub.findOne).toHaveBeenCalledWith(
        ORG_A,
        PRODUCT_ID,
        { kind: 'own', sellerId: noScopeCtx.userId },
        false,
        STANDARD,
      );
    });

    it('transmet tel quel le résultat du service (aucune transformation en aval)', async () => {
      serviceStub.findOne.mockResolvedValueOnce({
        product: {},
        sales: [],
        auditLogs: [],
      });
      const result = await controller.findOne(PRODUCT_ID, ctxA);
      expect(result).toEqual({ product: {}, sales: [], auditLogs: [] });
    });
  });

  it('update sans image : ne touche pas le stockage, transmet newImage undefined', async () => {
    const dto = { name: 'N2' };
    await controller.update(PRODUCT_ID, dto, undefined, user, ctxA);
    expect(s3Stub.uploadValidatedImage).not.toHaveBeenCalled();
    expect(serviceStub.update).toHaveBeenCalledWith(
      ORG_A,
      PRODUCT_ID,
      dto,
      actorId,
      undefined,
      FULL,
    );
  });

  it('update avec nouvelle image : envoi sous le préfixe de l’org puis transmission de la référence', async () => {
    const dto = { name: 'N2' };
    await controller.update(PRODUCT_ID, dto, imageFile(), user, ctxA);
    expect(s3Stub.uploadValidatedImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      PREFIX_A,
      expect.objectContaining({ contentType: 'image/png' }),
    );
    expect(serviceStub.update).toHaveBeenCalledWith(
      ORG_A,
      PRODUCT_ID,
      dto,
      actorId,
      STORED,
      FULL,
    );
    expect(s3Stub.deleteStoredObject).not.toHaveBeenCalled();
  });

  it('update avec nouvelle image : mutation échouée → supprime la nouvelle image et repropage l’erreur', async () => {
    const dto = { name: 'N2' };
    const error = new Error('mutation failed');
    serviceStub.update.mockRejectedValueOnce(error);
    await expect(
      controller.update(PRODUCT_ID, dto, imageFile(), user, ctxA),
    ).rejects.toBe(error);
    expect(quotaStub.discard).toHaveBeenCalledWith(STORED);
  });

  it('update sans image : mutation échouée ne déclenche aucun appel S3', async () => {
    const dto = { name: 'N2' };
    const error = new Error('mutation failed');
    serviceStub.update.mockRejectedValueOnce(error);
    await expect(
      controller.update(PRODUCT_ID, dto, undefined, user, ctxA),
    ).rejects.toBe(error);
    expect(s3Stub.deleteStoredObject).not.toHaveBeenCalled();
    expect(quotaStub.discard).not.toHaveBeenCalled();
  });

  describe('update — permissions dynamiques (correctif 1-7B : stock+prix ⇒ stock.adjust, catalogue/images ⇒ products.manage)', () => {
    const productsManageOnly = makeContext(ORG_A, OrganizationRole.SELLER, [
      'products.manage',
    ]);
    const stockAdjustOnly = makeContext(ORG_A, OrganizationRole.SELLER, [
      'stock.adjust',
    ]);
    const both = makeContext(ORG_A, OrganizationRole.SELLER, [
      'products.manage',
      'stock.adjust',
    ]);
    const none = makeContext(ORG_A, OrganizationRole.SELLER, []);

    it('champ descriptif (name) : products.manage seul suffit, stock.adjust non requis', async () => {
      await controller.update(
        PRODUCT_ID,
        { name: 'N2' },
        undefined,
        user,
        productsManageOnly,
      );
      expect(serviceStub.update).toHaveBeenCalledTimes(1);
    });

    it('champ descriptif (name) : refusé SANS products.manage, même avec stock.adjust', async () => {
      await expect(
        controller.update(
          PRODUCT_ID,
          { name: 'N2' },
          undefined,
          user,
          stockAdjustOnly,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(serviceStub.update).not.toHaveBeenCalled();
    });

    it('champ stock (additionalStock) : stock.adjust seul suffit, products.manage non requis', async () => {
      await controller.update(
        PRODUCT_ID,
        { additionalStock: 5 },
        undefined,
        user,
        stockAdjustOnly,
      );
      expect(serviceStub.update).toHaveBeenCalledTimes(1);
    });

    it('champ prix (purchasePrice/salePrice) : refusé SANS stock.adjust, même avec products.manage', async () => {
      await expect(
        controller.update(
          PRODUCT_ID,
          { purchasePrice: 12 },
          undefined,
          user,
          productsManageOnly,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(serviceStub.update).not.toHaveBeenCalled();
    });

    it('mélange (name + purchasePrice) : exige LES DEUX permissions', async () => {
      await expect(
        controller.update(
          PRODUCT_ID,
          { name: 'N2', purchasePrice: 12 },
          undefined,
          user,
          productsManageOnly,
        ),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        controller.update(
          PRODUCT_ID,
          { name: 'N2', purchasePrice: 12 },
          undefined,
          user,
          stockAdjustOnly,
        ),
      ).rejects.toThrow(ForbiddenException);

      await controller.update(
        PRODUCT_ID,
        { name: 'N2', purchasePrice: 12 },
        undefined,
        user,
        both,
      );
      expect(serviceStub.update).toHaveBeenCalledTimes(1);
    });

    it('image seule (aucun champ DTO) : traitée comme descriptive ⇒ products.manage requis', async () => {
      await expect(
        controller.update(PRODUCT_ID, {}, imageFile(), user, stockAdjustOnly),
      ).rejects.toThrow(ForbiddenException);
      // Refus de permission AVANT tout contrôle ou envoi de la photo.
      expect(s3Stub.uploadValidatedImage).not.toHaveBeenCalled();

      await controller.update(
        PRODUCT_ID,
        {},
        imageFile(),
        user,
        productsManageOnly,
      );
      expect(serviceStub.update).toHaveBeenCalledTimes(1);
    });

    it('DTO vide et sans image : retombe sur products.manage (jamais une route sans permission)', async () => {
      await expect(
        controller.update(PRODUCT_ID, {}, undefined, user, none),
      ).rejects.toThrow(ForbiddenException);

      await controller.update(
        PRODUCT_ID,
        {},
        undefined,
        user,
        productsManageOnly,
      );
      expect(serviceStub.update).toHaveBeenCalledTimes(1);
    });

    it('403 refusé porte le corps PERMISSION_DENIED uniforme', async () => {
      let thrown: unknown;
      try {
        await controller.update(
          PRODUCT_ID,
          { name: 'N2' },
          undefined,
          user,
          none,
        );
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ForbiddenException);
      expect((thrown as ForbiddenException).getResponse()).toEqual({
        code: 'PERMISSION_DENIED',
        message: 'Permission insuffisante.',
      });
    });
  });

  it('remove : transmet l’org du contexte AVANT id et actorId', async () => {
    await controller.remove(PRODUCT_ID, user, ctxA);
    expect(serviceStub.remove).toHaveBeenCalledWith(
      ORG_A,
      PRODUCT_ID,
      actorId,
      FULL,
    );
  });

  it('restore / permanentDelete : transmettent l’org du contexte AVANT l’id', async () => {
    await controller.restore(PRODUCT_ID, ctxA);
    expect(serviceStub.restore).toHaveBeenCalledWith(ORG_A, PRODUCT_ID, FULL);

    await controller.permanentDelete(PRODUCT_ID, ctxA);
    expect(serviceStub.permanentDelete).toHaveBeenCalledWith(
      ORG_A,
      PRODUCT_ID,
      FULL,
    );
  });

  it('aucune opération ne reçoit une org du body falsifié : seul l’org du contexte part', async () => {
    // Le contexte branché par la garde porte A : même si un attaquant
    // injecterait B dans le body (ici simulé sur le DTO), le service ne
    // reçoit QUE A.
    const dto = {
      sectionId: SECTION_QUERY,
      name: 'X',
      purchasePrice: 1,
      salePrice: 2,
      initialQuantity: 1,
      organizationId: 'b'.repeat(24),
    };
    await controller.create(dto, imageFile(), user, ctxA);
    expect(serviceStub.create).toHaveBeenCalledTimes(1);
    expect(serviceStub.create.mock.calls[0][0]).toBe(ORG_A);
  });
});
