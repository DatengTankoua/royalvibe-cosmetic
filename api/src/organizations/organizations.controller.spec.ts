import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { ResolvedOrganizationContext } from './organizations.service';
import { OrganizationRole } from './permissions';
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

/** Capture une exception SYNCHRONE ou une rejection (méthodes du contrôleur non-async). */
async function thrown(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

/**
 * OrganizationsController (1-6B.1) — autorisation TEMPORAIRE
 * `context.role === owner` uniquement ; `organizationId` provient
 * EXCLUSIVEMENT de `@CurrentOrganization()`, jamais du DTO/body.
 */
describe('OrganizationsController — invitations (1-6B.1)', () => {
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
  const adminCtx = makeContext(ORG_A, OrganizationRole.ADMIN);
  const sellerCtx = makeContext(ORG_A, OrganizationRole.SELLER);
  const dto = { email: 'invite@example.com', role: OrganizationRole.ADMIN };

  describe('create (POST /organizations/invitations)', () => {
    it('owner → transmet organizationId du CONTEXTE + invitedById du USER courant', async () => {
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

    it.each([
      ['admin', adminCtx],
      ['seller', sellerCtx],
    ])('%s → 403 OWNER_ONLY, service jamais appelé', async (_label, ctx) => {
      const error = await thrown(() => controller.create(dto, user, ctx));
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'OWNER_ONLY',
      });
      expect(serviceStub.createInvitation).not.toHaveBeenCalled();
    });
  });

  describe('findAll (GET /organizations/invitations)', () => {
    it('owner → liste UNIQUEMENT l’organisation du contexte', async () => {
      serviceStub.listInvitations.mockResolvedValue([]);
      await controller.findAll(ownerCtx);
      expect(serviceStub.listInvitations).toHaveBeenCalledWith(ORG_A);
    });

    it('org B falsifiée sans effet : seul le contexte réel (A) compte', async () => {
      serviceStub.listInvitations.mockResolvedValue([]);
      await controller.findAll(makeContext(ORG_A, OrganizationRole.OWNER));
      expect(serviceStub.listInvitations).not.toHaveBeenCalledWith(ORG_B);
    });

    it.each([
      ['admin', adminCtx],
      ['seller', sellerCtx],
    ])('%s → 403 OWNER_ONLY, service jamais appelé', async (_label, ctx) => {
      const error = await thrown(() => controller.findAll(ctx));
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(serviceStub.listInvitations).not.toHaveBeenCalled();
    });
  });

  describe('revoke (POST /organizations/invitations/:id/revoke)', () => {
    it('owner → transmet organizationId du contexte + id du paramètre', async () => {
      serviceStub.revokeInvitation.mockResolvedValue({});
      await controller.revoke(INVITATION_ID, ownerCtx);
      expect(serviceStub.revokeInvitation).toHaveBeenCalledWith(
        ORG_A,
        INVITATION_ID,
      );
    });

    it.each([
      ['admin', adminCtx],
      ['seller', sellerCtx],
    ])('%s → 403 OWNER_ONLY, service jamais appelé', async (_label, ctx) => {
      const error = await thrown(() => controller.revoke(INVITATION_ID, ctx));
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(serviceStub.revokeInvitation).not.toHaveBeenCalled();
    });
  });
});
