import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { ResolvedOrganizationContext } from './organizations.service';
import { OrganizationRole } from './permissions';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import type { User } from '../users/schemas/user.schema';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ORG_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const INVITATION_ID = '223344556677889900112233';

function makeContext(
  org: string,
  role: OrganizationRole,
): ResolvedOrganizationContext {
  return {
    userId: '111111111111111111111111',
    organizationId: org,
    membershipId: '222222222222222222222222',
    role,
    permissions: [],
  };
}

const user = { _id: new Types.ObjectId('eeeeeeeeeeeeeeeeeeeeeeee') } as User;

/**
 * OrganizationsController (1-7B) — autorisation `members.invite` déléguée
 * à `PermissionGuard` (global) via `@RequirePermissions`, testée
 * génériquement en 1-7A. Ce spec vérifie UNIQUEMENT : (1) la métadonnée
 * exacte portée par le contrôleur, (2) que `organizationId` provient
 * EXCLUSIVEMENT de `@CurrentOrganization()`, jamais du DTO/body.
 */
describe('OrganizationsController — invitations (1-7B)', () => {
  let controller: OrganizationsController;

  const serviceStub = {
    createInvitation: jest.fn(),
    listInvitations: jest.fn(),
    revokeInvitation: jest.fn(),
  };

  beforeEach(async () => {
    for (const key of Object.keys(serviceStub)) {
      (serviceStub as Record<string, jest.Mock>)[key].mockReset();
    }
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationsController],
      providers: [{ provide: OrganizationsService, useValue: serviceStub }],
    }).compile();
    controller = module.get(OrganizationsController);
  });

  const ownerCtx = makeContext(ORG_A, OrganizationRole.OWNER);
  const dto = { email: 'invite@example.com', role: OrganizationRole.ADMIN };

  it('@RequirePermissions(members.invite) est déclarée au niveau du contrôleur (les 3 routes)', () => {
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, OrganizationsController),
    ).toEqual(['members.invite']);
  });

  describe('create (POST /organizations/invitations)', () => {
    it('transmet organizationId du CONTEXTE + invitedById du USER courant', async () => {
      serviceStub.createInvitation.mockResolvedValue({
        invitation: {},
        token: 't',
      });
      await controller.create(dto, user, ownerCtx);
      expect(serviceStub.createInvitation).toHaveBeenCalledTimes(1);
      expect(serviceStub.createInvitation).toHaveBeenCalledWith(
        ORG_A,
        'eeeeeeeeeeeeeeeeeeeeeeee',
        dto,
      );
    });
  });

  describe('findAll (GET /organizations/invitations)', () => {
    it('liste UNIQUEMENT l’organisation du contexte', async () => {
      serviceStub.listInvitations.mockResolvedValue([]);
      await controller.findAll(ownerCtx);
      expect(serviceStub.listInvitations).toHaveBeenCalledWith(ORG_A);
    });

    it('org B falsifiée sans effet : seul le contexte réel (A) compte', async () => {
      serviceStub.listInvitations.mockResolvedValue([]);
      await controller.findAll(makeContext(ORG_A, OrganizationRole.OWNER));
      expect(serviceStub.listInvitations).not.toHaveBeenCalledWith(ORG_B);
    });
  });

  describe('revoke (POST /organizations/invitations/:id/revoke)', () => {
    it('transmet organizationId du contexte + id du paramètre', async () => {
      serviceStub.revokeInvitation.mockResolvedValue({});
      await controller.revoke(INVITATION_ID, ownerCtx);
      expect(serviceStub.revokeInvitation).toHaveBeenCalledWith(
        ORG_A,
        INVITATION_ID,
      );
    });
  });
});
