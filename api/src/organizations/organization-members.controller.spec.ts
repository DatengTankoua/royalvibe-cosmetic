import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationMembersController } from './organization-members.controller';
import { OrganizationsService } from './organizations.service';
import { ResolvedOrganizationContext } from './organizations.service';
import { OrganizationRole } from './permissions';
import {
  PERMISSIONS_KEY,
  OWNER_ONLY_KEY,
} from '../auth/decorators/permissions.decorator';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ACTOR_USER_ID = '111111111111111111111111';
const TARGET_MEMBERSHIP_ID = '223344556677889900112233';

function makeContext(): ResolvedOrganizationContext {
  return {
    userId: ACTOR_USER_ID,
    organizationId: ORG_A,
    membershipId: '222222222222222222222222',
    role: OrganizationRole.OWNER,
    permissions: [],
  };
}

/** Reflect la métadonnée telle que NestJS la stocke (méthode > classe). */
function readMetadata(
  key: string,
  controllerType: object,
  methodName: string,
): unknown {
  const proto = (controllerType as { prototype: Record<string, unknown> })
    .prototype;
  const handler = proto[methodName];
  if (typeof handler === 'function') {
    const onHandler: unknown = Reflect.getMetadata(key, handler);
    if (onHandler !== undefined) return onHandler;
  }
  return Reflect.getMetadata(key, controllerType);
}

describe('OrganizationMembersController (1-7C)', () => {
  let controller: OrganizationMembersController;

  const serviceStub = {
    listMembers: jest.fn(),
    updateMembership: jest.fn(),
    transferOwnership: jest.fn(),
  };

  beforeEach(async () => {
    for (const key of Object.keys(serviceStub)) {
      serviceStub[key].mockReset();
      serviceStub[key].mockResolvedValue(undefined);
    }
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationMembersController],
      providers: [{ provide: OrganizationsService, useValue: serviceStub }],
    }).compile();
    controller = module.get(OrganizationMembersController);
  });

  const ctx = makeContext();

  it('GET / déclare @RequirePermissions(members.manage)', () => {
    expect(
      readMetadata(PERMISSIONS_KEY, OrganizationMembersController, 'findAll'),
    ).toEqual(['members.manage']);
  });

  it('PATCH /:id déclare @RequirePermissions(members.manage)', () => {
    expect(
      readMetadata(PERMISSIONS_KEY, OrganizationMembersController, 'update'),
    ).toEqual(['members.manage']);
  });

  it('POST /:id/transfer-ownership déclare @OwnerOnly(ownership.transfer), jamais @RequirePermissions', () => {
    expect(
      readMetadata(
        OWNER_ONLY_KEY,
        OrganizationMembersController,
        'transferOwnership',
      ),
    ).toBe('ownership.transfer');
    expect(
      readMetadata(
        PERMISSIONS_KEY,
        OrganizationMembersController,
        'transferOwnership',
      ),
    ).toBeUndefined();
  });

  it('findAll : transmet UNIQUEMENT l’org du contexte, jamais un paramètre client', async () => {
    await controller.findAll(ctx);
    expect(serviceStub.listMembers).toHaveBeenCalledWith(ORG_A);
  });

  it('update : transmet org + userId de l’ACTEUR (contexte) + id du paramètre + dto, jamais falsifiables', async () => {
    const dto = { role: OrganizationRole.ADMIN };
    await controller.update(TARGET_MEMBERSHIP_ID, dto, ctx);
    expect(serviceStub.updateMembership).toHaveBeenCalledWith(
      ORG_A,
      ACTOR_USER_ID,
      TARGET_MEMBERSHIP_ID,
      dto,
    );
  });

  it('transferOwnership : transmet org + userId de l’acteur (contexte) + id de la cible', async () => {
    await controller.transferOwnership(TARGET_MEMBERSHIP_ID, ctx);
    expect(serviceStub.transferOwnership).toHaveBeenCalledWith(
      ORG_A,
      ACTOR_USER_ID,
      TARGET_MEMBERSHIP_ID,
    );
  });

  it('falsification organizationId dans un DTO sans effet : seul le contexte compte', async () => {
    const forgedDto = {
      role: OrganizationRole.ADMIN,
      organizationId: 'b'.repeat(24),
    };
    await controller.update(TARGET_MEMBERSHIP_ID, forgedDto, ctx);
    expect(serviceStub.updateMembership.mock.calls[0][0]).toBe(ORG_A);
  });
});
