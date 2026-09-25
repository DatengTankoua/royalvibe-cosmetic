import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { OrganizationRole } from '../organizations/permissions';
import type { User } from '../users/schemas/user.schema';

const VALID_OBJECT_ID = '112233445566778899001122';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ORG_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const SELLER_ID = 'eeeeeeeeeeeeeeeeeeeeeeee';

function makeContext(
  org: string,
  role: OrganizationRole = OrganizationRole.OWNER,
  permissions: ResolvedOrganizationContext['permissions'] = ['catalog.manage'],
): ResolvedOrganizationContext {
  return {
    userId: SELLER_ID,
    organizationId: org,
    membershipId: '222222222222222222222222',
    role,
    permissions,
  };
}

const seller = { _id: new Types.ObjectId(SELLER_ID) } as User;
const saleDto = {
  productId: VALID_OBJECT_ID,
  quantity: 3,
  salePrice: 500,
  buyerName: 'Bob',
};

/**
 * Reads the parameter pipes the SalesController declares on :id, exactly the
 * way Nest 11 stores them: `@Param` writes
 * `Reflect.defineMetadata('__routeArguments__', { [<key>]: { index, data,
 * pipes } }, target.constructor, methodName)`. The map key embeds a uid
 * generated per decorator, so we scan the map values instead of
 * reconstructing it.
 */
function readParamPipes(methodName: string): object[] {
  const args = (Reflect.getMetadata(
    '__routeArguments__',
    SalesController,
    methodName,
  ) ?? {}) as Record<string, { pipes?: object[] }>;
  return Object.values(args).flatMap((arg) => arg.pipes ?? []);
}

describe('SalesController :id validation (sec: M-1, phase 0B.1)', () => {
  describe('route metadata (real decorators)', () => {
    it('PATCH /sales/:id applies ParseObjectIdPipe to the id parameter', () => {
      expect(
        readParamPipes('update').some((p) => p === ParseObjectIdPipe),
      ).toBe(true);
    });

    it('DELETE /sales/:id applies ParseObjectIdPipe to the id parameter', () => {
      expect(
        readParamPipes('remove').some((p) => p === ParseObjectIdPipe),
      ).toBe(true);
    });
  });

  describe('pipe behaviour (the exact pipe the routes must use)', () => {
    const pipe = new ParseObjectIdPipe();

    it('accepts a valid ObjectId unchanged', () => {
      expect(pipe.transform(VALID_OBJECT_ID)).toBe(VALID_OBJECT_ID);
    });

    it.each([
      ['not-an-id', 'an arbitrary string'],
      ['', 'an empty string'],
      ['../../../etc/passwd', 'a traversal string'],
    ])('refuses %s with a BadRequestException', (_label, value) => {
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
    });
  });
});

/**
 * SalesController (1-4C.1) — la création de vente transmet EXACTEMENT
 * `organizationContext.organizationId` comme PREMIER argument au service :
 * jamais une valeur issue du body (le DTO ne porte jamais l'org), de la
 * query ou des headers. Seule la route `POST /sales` porte ce décorateur.
 */
describe('SalesController — transmission du tenant à la création (1-4C.1)', () => {
  let controller: SalesController;

  const serviceStub = {
    create: jest.fn(),
    findAll: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };

  beforeEach(async () => {
    for (const key of Object.keys(serviceStub)) {
      serviceStub[key].mockReset();
      serviceStub[key].mockResolvedValue(undefined);
    }
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SalesController],
      providers: [{ provide: SalesService, useValue: serviceStub }],
    }).compile();
    controller = module.get(SalesController);
  });

  const ctxA = makeContext(ORG_A);

  it('create : transmet l’org du contexte AVANT le DTO et le sellerId', async () => {
    await controller.create(saleDto, seller, ctxA);
    expect(serviceStub.create).toHaveBeenCalledTimes(1);
    expect(serviceStub.create).toHaveBeenCalledWith(ORG_A, saleDto, SELLER_ID);
  });

  it('create : un `organizationId` falsifié dans le DTO n’influence jamais l’org transmise', async () => {
    const forgedDto = { ...saleDto, organizationId: ORG_B };
    await controller.create(forgedDto, seller, ctxA);
    expect(serviceStub.create).toHaveBeenCalledTimes(1);
    // le service reçoit QUE A (celle du contexte) :
    expect(serviceStub.create.mock.calls[0][0]).toBe(ORG_A);
  });

  it('findAll/update/remove transmettent l’org du contexte en premier argument', async () => {
    const patchDto = { quantity: 1, organizationId: ORG_B };

    await controller.findAll(VALID_OBJECT_ID, ctxA);
    expect(serviceStub.findAll).toHaveBeenCalledWith(ORG_A, VALID_OBJECT_ID);

    await controller.update(VALID_OBJECT_ID, patchDto, seller, ctxA);
    expect(serviceStub.update).toHaveBeenCalledWith(
      ORG_A,
      VALID_OBJECT_ID,
      patchDto,
      SELLER_ID,
    );

    await controller.remove(VALID_OBJECT_ID, seller, ctxA);
    expect(serviceStub.remove).toHaveBeenCalledWith(
      ORG_A,
      VALID_OBJECT_ID,
      SELLER_ID,
    );
  });
});

/**
 * SalesController (1-7B) — scope `sales.view_own` vs `sales.view_all` :
 * décidé dans le contrôleur (pas via une simple métadonnée ET), car c'est
 * un OU entre deux permissions à comportement différent.
 */
describe('SalesController — scope own/all (1-7B)', () => {
  let controller: SalesController;

  const serviceStub = {
    create: jest.fn(),
    findAll: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };

  beforeEach(async () => {
    for (const key of Object.keys(serviceStub)) {
      serviceStub[key].mockReset();
      serviceStub[key].mockResolvedValue(undefined);
    }
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SalesController],
      providers: [{ provide: SalesService, useValue: serviceStub }],
    }).compile();
    controller = module.get(SalesController);
  });

  const sellerDefaultCtx = makeContext(ORG_A, OrganizationRole.SELLER, []);
  const sellerViewAllCtx = makeContext(ORG_A, OrganizationRole.SELLER, [
    'sales.view_all',
  ]);
  // `owner`/`admin`/`seller` couvrent TOUJOURS au moins l'une des deux
  // permissions par défaut (invariant de `DEFAULT_PERMISSIONS_BY_ROLE`) :
  // le rôle bidon simule un futur rôle sans défaut, pour couvrir la branche
  // défensive 403 (jamais atteignable avec les 3 rôles actuels).
  const noScopeCtx = makeContext(
    ORG_A,
    'guest' as unknown as OrganizationRole,
    [],
  );

  it('findAll : seller par défaut (sales.view_own) → scope sellerId = userId du contexte', async () => {
    await controller.findAll(undefined, sellerDefaultCtx);
    expect(serviceStub.findAll).toHaveBeenCalledWith(
      ORG_A,
      undefined,
      SELLER_ID,
    );
  });

  it('findAll : seller délégué sales.view_all → aucun scope (voit toute l’organisation)', async () => {
    await controller.findAll(undefined, sellerViewAllCtx);
    expect(serviceStub.findAll).toHaveBeenCalledWith(ORG_A, undefined);
  });

  it('findAll : ni sales.view_own ni sales.view_all → 403 PERMISSION_DENIED, service jamais appelé', () => {
    let thrown: unknown;
    try {
      // Lève SYNCHRONEMENT avant tout retour de Promise (branche refusée).
      void controller.findAll(undefined, noScopeCtx);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as ForbiddenException).getResponse()).toEqual({
      code: 'PERMISSION_DENIED',
      message: 'Permission insuffisante.',
    });
    expect(serviceStub.findAll).not.toHaveBeenCalled();
  });

  it('update : seller par défaut → scope sellerId = userId du contexte (vente d’un autre seller ⇒ 404 côté service)', async () => {
    const dto = { quantity: 2 };
    await controller.update(VALID_OBJECT_ID, dto, seller, sellerDefaultCtx);
    expect(serviceStub.update).toHaveBeenCalledWith(
      ORG_A,
      VALID_OBJECT_ID,
      dto,
      SELLER_ID,
      SELLER_ID,
    );
  });

  it('update : seller délégué sales.view_all → aucun scope (peut modifier n’importe quelle vente de l’org)', async () => {
    const dto = { quantity: 2 };
    await controller.update(VALID_OBJECT_ID, dto, seller, sellerViewAllCtx);
    expect(serviceStub.update).toHaveBeenCalledWith(
      ORG_A,
      VALID_OBJECT_ID,
      dto,
      SELLER_ID,
    );
  });

  it('remove : seller par défaut → scope sellerId = userId du contexte', async () => {
    await controller.remove(VALID_OBJECT_ID, seller, sellerDefaultCtx);
    expect(serviceStub.remove).toHaveBeenCalledWith(
      ORG_A,
      VALID_OBJECT_ID,
      SELLER_ID,
      SELLER_ID,
    );
  });

  it('remove : seller délégué sales.view_all → aucun scope', async () => {
    await controller.remove(VALID_OBJECT_ID, seller, sellerViewAllCtx);
    expect(serviceStub.remove).toHaveBeenCalledWith(
      ORG_A,
      VALID_OBJECT_ID,
      SELLER_ID,
    );
  });
});
