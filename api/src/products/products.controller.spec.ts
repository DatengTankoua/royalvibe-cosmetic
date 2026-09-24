import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { S3Service } from '../s3/s3.service';
import { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { OrganizationRole } from '../organizations/permissions';
import type { User } from '../users/schemas/user.schema';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PRODUCT_ID = '223344556677889900112233';
const SECTION_QUERY = '112233445566778899001122';

/**
 * Le contexte est celui BRANCHÉ par `OrganizationGuard` sur `request` :
 * seul le `@CurrentOrganization()` du contrôleur peut le produire ici —
 * aucun paramètre du client n'est impliqué.
 */
function makeContext(org: string): ResolvedOrganizationContext {
  return {
    userId: '111111111111111111111111',
    organizationId: org,
    membershipId: '222222222222222222222222',
    role: OrganizationRole.OWNER,
    permissions: ['catalog.manage'],
  };
}

const user = { _id: new Types.ObjectId('eeeeeeeeeeeeeeeeeeeeeeee') } as User;
const file = {
  buffer: Buffer.from('x'),
  originalname: 'a.png',
} as Express.Multer.File;

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
  };

  const s3Stub = {
    uploadFile: jest.fn().mockResolvedValue('http://s3-e2e/key.png'),
  };

  beforeEach(async () => {
    for (const key of Object.keys(serviceStub)) {
      serviceStub[key].mockReset();
      serviceStub[key].mockResolvedValue(undefined);
    }
    s3Stub.uploadFile.mockReset().mockResolvedValue('http://s3-e2e/key.png');
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProductsController],
      providers: [
        { provide: ProductsService, useValue: serviceStub },
        { provide: S3Service, useValue: s3Stub },
      ],
    }).compile();
    controller = module.get(ProductsController);
  });

  const ctxA = makeContext(ORG_A);
  const actorId = 'eeeeeeeeeeeeeeeeeeeeeeee';

  it('create : transmet l’org du contexte AVANT le DTO, imageUrl et actorId', async () => {
    const dto = {
      sectionId: SECTION_QUERY,
      name: 'N',
      purchasePrice: 5,
      salePrice: 10,
      initialQuantity: 7,
    };
    await controller.create(dto, file, user, ctxA);
    expect(s3Stub.uploadFile).toHaveBeenCalledTimes(1);
    expect(serviceStub.create).toHaveBeenCalledTimes(1);
    expect(serviceStub.create).toHaveBeenCalledWith(
      ORG_A,
      dto,
      'http://s3-e2e/key.png',
      actorId,
    );
  });

  it('findAll : transmet l’org du contexte + sectionId de la query inchangée', async () => {
    await controller.findAll(SECTION_QUERY, ctxA);
    expect(serviceStub.findAll).toHaveBeenCalledTimes(1);
    expect(serviceStub.findAll).toHaveBeenCalledWith(ORG_A, SECTION_QUERY);

    await controller.findAll(undefined, ctxA);
    expect(serviceStub.findAll).toHaveBeenCalledWith(ORG_A, undefined);
  });

  it('findOne : transmet l’org du contexte + l’id du paramètre', async () => {
    await controller.findOne(PRODUCT_ID, ctxA);
    expect(serviceStub.findOne).toHaveBeenCalledWith(ORG_A, PRODUCT_ID);
  });

  it('update : transmet l’org du contexte AVANT id, DTO et actorId', async () => {
    const dto = { name: 'N2' };
    await controller.update(PRODUCT_ID, dto, user, ctxA);
    expect(serviceStub.update).toHaveBeenCalledWith(
      ORG_A,
      PRODUCT_ID,
      dto,
      actorId,
    );
  });

  it('remove : transmet l’org du contexte AVANT id et actorId', async () => {
    await controller.remove(PRODUCT_ID, user, ctxA);
    expect(serviceStub.remove).toHaveBeenCalledWith(ORG_A, PRODUCT_ID, actorId);
  });

  it('restore / permanentDelete : transmettent l’org du contexte AVANT l’id', async () => {
    await controller.restore(PRODUCT_ID, ctxA);
    expect(serviceStub.restore).toHaveBeenCalledWith(ORG_A, PRODUCT_ID);

    await controller.permanentDelete(PRODUCT_ID, ctxA);
    expect(serviceStub.permanentDelete).toHaveBeenCalledWith(ORG_A, PRODUCT_ID);
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
    await controller.create(dto, file, user, ctxA);
    expect(serviceStub.create).toHaveBeenCalledTimes(1);
    expect(serviceStub.create.mock.calls[0][0]).toBe(ORG_A);
  });
});
