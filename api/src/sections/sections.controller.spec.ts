import { Test, TestingModule } from '@nestjs/testing';
import { SectionsController } from './sections.controller';
import { SectionsService } from './sections.service';
import { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { OrganizationRole } from '../organizations/permissions';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const SECTION_ID = '112233445566778899001122';
const PARENT_QUERY = '223344556677889900112233';

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

/**
 * SectionsController (1-4A) — chaque route transmet EXACTEMENT
 * `organizationContext.organizationId` au service : jamais une valeur
 * issue du DTO, de la query ou des headers.
 */
describe('SectionsController — transmission du tenant (1-4A)', () => {
  let controller: SectionsController;

  const serviceStub = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    restore: jest.fn(),
    remove: jest.fn(),
    permanentDelete: jest.fn(),
    findTrashed: jest.fn(),
  };

  beforeEach(async () => {
    for (const key of Object.keys(serviceStub)) {
      serviceStub[key].mockReset();
      serviceStub[key].mockResolvedValue(undefined);
    }
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SectionsController],
      providers: [{ provide: SectionsService, useValue: serviceStub }],
    }).compile();
    controller = module.get(SectionsController);
  });

  const ctxA = makeContext(ORG_A);

  it('create : transmet l’org du contexte (le DTO n’apporte jamais l’org)', async () => {
    const dto = { name: 'N', description: 'd' };
    await controller.create(dto, ctxA);
    expect(serviceStub.create).toHaveBeenCalledTimes(1);
    expect(serviceStub.create).toHaveBeenCalledWith(ORG_A, dto);
  });

  it('findAll : transmet l’org du contexte + parentId de la query inchangée', async () => {
    await controller.findAll(PARENT_QUERY, ctxA);
    expect(serviceStub.findAll).toHaveBeenCalledTimes(1);
    expect(serviceStub.findAll).toHaveBeenCalledWith(ORG_A, PARENT_QUERY);

    await controller.findAll(undefined, ctxA);
    expect(serviceStub.findAll).toHaveBeenCalledWith(ORG_A, undefined);
  });

  it('findOne : transmet l’org du contexte + l’id du paramètre', async () => {
    await controller.findOne(SECTION_ID, ctxA);
    expect(serviceStub.findOne).toHaveBeenCalledWith(ORG_A, SECTION_ID);
  });

  it('update : transmet l’org du contexte + id et DTO inchangés', async () => {
    const dto = { name: 'N2' };
    await controller.update(SECTION_ID, dto, ctxA);
    expect(serviceStub.update).toHaveBeenCalledWith(ORG_A, SECTION_ID, dto);
  });

  it('remove / restore / permanentDelete : transmettent l’org du contexte', async () => {
    await controller.remove(SECTION_ID, ctxA);
    expect(serviceStub.remove).toHaveBeenCalledWith(ORG_A, SECTION_ID);

    await controller.restore(SECTION_ID, ctxA);
    expect(serviceStub.restore).toHaveBeenCalledWith(ORG_A, SECTION_ID);

    await controller.permanentDelete(SECTION_ID, ctxA);
    expect(serviceStub.permanentDelete).toHaveBeenCalledWith(ORG_A, SECTION_ID);
  });

  it('aucune opération ne reçoit une org du faux contexte (B) quand le vrai est A', async () => {
    // Le contexte branché par la garde porte A : même si un attaquant
    // injecterait B dans le body (ici simulé sur le DTO), le service ne
    // reçoit QUE A.
    const dto = { name: 'X', organizationId: 'b'.repeat(24) };
    serviceStub.create.mockResolvedValue({ ok: true });

    await controller.create(dto, ctxA);
    const calls = serviceStub.create.mock.calls;
    expect(calls[0][0]).toBe(ORG_A);
  });
});
