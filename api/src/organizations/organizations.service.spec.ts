import { ForbiddenException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { OrganizationsService } from './organizations.service';
import { Organization } from './schemas/organization.schema';
import { OrganizationMembership } from './schemas/membership.schema';
import {
  DelegablePermission,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
} from './permissions';

const USER_OBJECT_ID = '112233445566778899001122';
const ORG_OBJECT_ID = '223344556677889900112233';
const MEMBERSHIP_OBJECT_ID = '334455667788990011223344';
const INVALID_ID = 'invalid';
const ACCESS_DENIED_CODE = 'ORGANIZATION_ACCESS_DENIED';
const ACCESS_DENIED_MESSAGE = "Accès à l'organisation refusé.";

describe('OrganizationsService.resolveActiveContext', () => {
  let service: OrganizationsService;
  let membershipModel: { findOne: jest.Mock };
  let organizationModel: { findById: jest.Mock };
  let membershipChain: { exec: jest.Mock };
  let organizationChain: { exec: jest.Mock };

  async function build() {
    membershipChain = { exec: jest.fn() };
    organizationChain = { exec: jest.fn() };
    membershipModel = { findOne: jest.fn(() => membershipChain) };
    organizationModel = { findById: jest.fn(() => organizationChain) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsService,
        {
          provide: getModelToken(Organization.name),
          useValue: organizationModel,
        },
        {
          provide: getModelToken(OrganizationMembership.name),
          useValue: membershipModel,
        },
      ],
    }).compile();
    service = module.get(OrganizationsService);
  }

  function activeMembership(overrides: Record<string, unknown> = {}) {
    return {
      _id: new Types.ObjectId(MEMBERSHIP_OBJECT_ID),
      userId: new Types.ObjectId(USER_OBJECT_ID),
      organizationId: new Types.ObjectId(ORG_OBJECT_ID),
      role: OrganizationRole.SELLER,
      permissions: [
        'sales.view_all',
        'analytics.read',
      ] as DelegablePermission[],
      status: MembershipStatus.ACTIVE,
      ...overrides,
    };
  }

  function activeOrganization(overrides: Record<string, unknown> = {}) {
    return {
      _id: new Types.ObjectId(ORG_OBJECT_ID),
      status: OrganizationStatus.ACTIVE,
      ...overrides,
    };
  }

  async function expectAccessDenied(fn: () => Promise<unknown>) {
    const error = await fn().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    const exc = error as ForbiddenException;
    expect(exc.getStatus()).toBe(403);
    const response = exc.getResponse() as { code: string; message: string };
    expect(response.code).toBe(ACCESS_DENIED_CODE);
    expect(response.message).toBe(ACCESS_DENIED_MESSAGE);
  }

  // 1. contexte actif retourné
  it('contexte actif → contexte minimal (ids en strings, permissions copiées)', async () => {
    await build();
    membershipChain.exec.mockResolvedValue(activeMembership());
    organizationChain.exec.mockResolvedValue(activeOrganization());

    const ctx = await service.resolveActiveContext(
      USER_OBJECT_ID,
      ORG_OBJECT_ID,
    );

    expect(ctx).toEqual({
      userId: USER_OBJECT_ID,
      organizationId: ORG_OBJECT_ID,
      membershipId: MEMBERSHIP_OBJECT_ID,
      role: OrganizationRole.SELLER,
      permissions: ['sales.view_all', 'analytics.read'],
    });
  });

  // 2. userId invalide
  it('userId invalide → refus uniforme (aucune requête)', async () => {
    await build();
    await expectAccessDenied(() =>
      service.resolveActiveContext(INVALID_ID, ORG_OBJECT_ID),
    );
    expect(membershipModel.findOne).not.toHaveBeenCalled();
    expect(organizationModel.findById).not.toHaveBeenCalled();
  });

  // 3. organizationId invalide
  it('organizationId invalide → refus uniforme (aucune requête)', async () => {
    await build();
    await expectAccessDenied(() =>
      service.resolveActiveContext(USER_OBJECT_ID, INVALID_ID),
    );
    expect(membershipModel.findOne).not.toHaveBeenCalled();
    expect(organizationModel.findById).not.toHaveBeenCalled();
  });

  // 4. membership absente
  it('membership absente → refus uniforme (aucune recherche d’organisation)', async () => {
    await build();
    membershipChain.exec.mockResolvedValue(null);
    await expectAccessDenied(() =>
      service.resolveActiveContext(USER_OBJECT_ID, ORG_OBJECT_ID),
    );
    expect(membershipModel.findOne).toHaveBeenCalledTimes(1);
    expect(organizationModel.findById).not.toHaveBeenCalled();
  });

  // 5. membership suspendue
  it('membership suspendue → refus uniforme (aucune recherche d’organisation)', async () => {
    await build();
    membershipChain.exec.mockResolvedValue(
      activeMembership({ status: MembershipStatus.SUSPENDED }),
    );
    await expectAccessDenied(() =>
      service.resolveActiveContext(USER_OBJECT_ID, ORG_OBJECT_ID),
    );
    expect(membershipModel.findOne).toHaveBeenCalledTimes(1);
    expect(organizationModel.findById).not.toHaveBeenCalled();
  });

  // 6. membership révoquée
  it('membership révoquée → refus uniforme (aucune recherche d’organisation)', async () => {
    await build();
    membershipChain.exec.mockResolvedValue(
      activeMembership({ status: MembershipStatus.REVOKED }),
    );
    await expectAccessDenied(() =>
      service.resolveActiveContext(USER_OBJECT_ID, ORG_OBJECT_ID),
    );
    expect(membershipModel.findOne).toHaveBeenCalledTimes(1);
    expect(organizationModel.findById).not.toHaveBeenCalled();
  });

  // 7. organisation absente
  it('organisation absente → refus uniforme', async () => {
    await build();
    membershipChain.exec.mockResolvedValue(activeMembership());
    organizationChain.exec.mockResolvedValue(null);
    await expectAccessDenied(() =>
      service.resolveActiveContext(USER_OBJECT_ID, ORG_OBJECT_ID),
    );
    expect(organizationModel.findById).toHaveBeenCalledTimes(1);
  });

  // 8. organisation suspendue
  it('organisation suspendue → refus uniforme', async () => {
    await build();
    membershipChain.exec.mockResolvedValue(activeMembership());
    organizationChain.exec.mockResolvedValue(
      activeOrganization({ status: OrganizationStatus.SUSPENDED }),
    );
    await expectAccessDenied(() =>
      service.resolveActiveContext(USER_OBJECT_ID, ORG_OBJECT_ID),
    );
    expect(organizationModel.findById).toHaveBeenCalledTimes(1);
  });

  // 9. requête membership contenant simultanément userId et organizationId
  it('la requête membership porte bien { userId, organizationId } en ObjectId', async () => {
    await build();
    membershipChain.exec.mockResolvedValue(activeMembership());
    organizationChain.exec.mockResolvedValue(activeOrganization());

    await service.resolveActiveContext(USER_OBJECT_ID, ORG_OBJECT_ID);

    expect(membershipModel.findOne).toHaveBeenCalledTimes(1);
    const filter = membershipModel.findOne.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(filter).sort()).toEqual(['organizationId', 'userId']);
    expect(filter.userId).toBeInstanceOf(Types.ObjectId);
    expect((filter.userId as Types.ObjectId).toString()).toBe(USER_OBJECT_ID);
    expect(filter.organizationId).toBeInstanceOf(Types.ObjectId);
    expect((filter.organizationId as Types.ObjectId).toString()).toBe(
      ORG_OBJECT_ID,
    );
  });

  // 10. organisation recherchée avec l’ID issu de la membership
  it('l’organisation est recherchée avec l’ID issu de la membership (non le paramètre client)', async () => {
    await build();
    // La membership renvoyée par la base porte un organizationId DIFFÉRENT du
    // paramètre client : le code doit résoudre l’organisation depuis la
    // membership trouvée, jamais depuis l’identifiant fourni par le client.
    const orgFromMembership = '445566778899001122334455';
    membershipChain.exec.mockResolvedValue(
      activeMembership({
        organizationId: new Types.ObjectId(orgFromMembership),
      }),
    );
    organizationChain.exec.mockResolvedValue(
      activeOrganization({ _id: new Types.ObjectId(orgFromMembership) }),
    );

    await service.resolveActiveContext(USER_OBJECT_ID, ORG_OBJECT_ID);

    expect(organizationModel.findById).toHaveBeenCalledTimes(1);
    const arg = organizationModel.findById.mock.calls[0][0] as Types.ObjectId;
    expect(arg.toString()).toBe(orgFromMembership);
    expect(arg.toString()).not.toBe(ORG_OBJECT_ID);
  });

  // 11. toutes les erreurs ont exactement le même code/message
  it('tous les refus portent exactement le même code ET le même message', async () => {
    const scenarios: Array<() => Promise<unknown>> = [
      async () => {
        await build();
        return service.resolveActiveContext(INVALID_ID, ORG_OBJECT_ID);
      },
      async () => {
        await build();
        return service.resolveActiveContext(USER_OBJECT_ID, INVALID_ID);
      },
      async () => {
        await build();
        membershipChain.exec.mockResolvedValue(null);
        return service.resolveActiveContext(USER_OBJECT_ID, ORG_OBJECT_ID);
      },
      async () => {
        await build();
        membershipChain.exec.mockResolvedValue(
          activeMembership({ status: MembershipStatus.SUSPENDED }),
        );
        return service.resolveActiveContext(USER_OBJECT_ID, ORG_OBJECT_ID);
      },
      async () => {
        await build();
        membershipChain.exec.mockResolvedValue(
          activeMembership({ status: MembershipStatus.REVOKED }),
        );
        return service.resolveActiveContext(USER_OBJECT_ID, ORG_OBJECT_ID);
      },
      async () => {
        await build();
        membershipChain.exec.mockResolvedValue(activeMembership());
        organizationChain.exec.mockResolvedValue(null);
        return service.resolveActiveContext(USER_OBJECT_ID, ORG_OBJECT_ID);
      },
      async () => {
        await build();
        membershipChain.exec.mockResolvedValue(activeMembership());
        organizationChain.exec.mockResolvedValue(
          activeOrganization({ status: OrganizationStatus.SUSPENDED }),
        );
        return service.resolveActiveContext(USER_OBJECT_ID, ORG_OBJECT_ID);
      },
    ];

    const responses: unknown[] = [];
    for (const run of scenarios) {
      const error = await run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      responses.push((error as ForbiddenException).getResponse());
    }
    for (const response of responses) {
      expect(JSON.stringify(response)).toBe(
        JSON.stringify({
          code: ACCESS_DENIED_CODE,
          message: ACCESS_DENIED_MESSAGE,
        }),
      );
    }
  });

  // 12. les permissions retournées sont une copie, pas la référence du document
  it('permissions retournées : copie détachée du document', async () => {
    await build();
    const doc = activeMembership();
    membershipChain.exec.mockResolvedValue(doc);
    organizationChain.exec.mockResolvedValue(activeOrganization());

    const ctx = await service.resolveActiveContext(
      USER_OBJECT_ID,
      ORG_OBJECT_ID,
    );

    expect(ctx.permissions).toEqual(doc.permissions);
    expect(ctx.permissions).not.toBe(doc.permissions);
    ctx.permissions.push('trash.manage');
    expect(doc.permissions).toHaveLength(2);
  });
});
