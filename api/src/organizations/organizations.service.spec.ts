import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { getModelToken, getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { createHash } from 'crypto';
import * as bcrypt from 'bcryptjs';
import {
  OrganizationsService,
  INVITATION_INVALID_OR_EXPIRED,
} from './organizations.service';
import { Organization } from './schemas/organization.schema';
import { OrganizationMembership } from './schemas/membership.schema';
import { OrganizationInvitation } from './schemas/invitation.schema';
import { UsersService } from '../users/users.service';
import { UserRole } from '../users/schemas/user.schema';
import { SocketRegistryService } from './socket-registry.service';
import { S3Service } from '../s3/s3.service';

// Stub partagé (1-8A) : aucun test de ce fichier n'exerce `getCurrent`/
// `updateBranding`/`removeLogo` (couverts par leur propre describe) — seule
// la résolution DI du nouveau constructeur importe ici.
const s3ServiceStub = {
  publicUrlForKey: jest.fn((key: string) => `http://s3/${key}`),
};
import {
  DelegablePermission,
  InvitationStatus,
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
        {
          provide: getModelToken(OrganizationInvitation.name),
          useValue: {},
        },
        { provide: UsersService, useValue: { findByEmail: jest.fn() } },
        { provide: getConnectionToken(), useValue: {} },
        {
          provide: SocketRegistryService,
          useValue: { disconnectMember: jest.fn() },
        },
        { provide: S3Service, useValue: s3ServiceStub },
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

// =============================================================================
// listActiveOrganizations (phase 1-3B.1) — tests directs
// =============================================================================
describe('OrganizationsService.listActiveOrganizations', () => {
  let service: OrganizationsService;
  let organizationModel: { findById: jest.Mock };
  let membershipModel: { find: jest.Mock };
  // « DB » simulée : les mocks rejouent le comportement MongoDB (filtre
  // userId/status sur `find`, lookup par identifiant sur `findById`) pour que
  // l'exclusion par filtres de base soit réellement observable.
  let membershipDb: unknown[];
  let organizationDb: unknown[];
  let orgByIdCalls: unknown[];

  async function buildList() {
    membershipDb = [];
    organizationDb = [];
    orgByIdCalls = [];
    membershipModel = {
      find: jest.fn((filter: Record<string, unknown>) => ({
        exec: (): Promise<unknown[]> =>
          Promise.resolve(
            membershipDb.filter(
              (m) =>
                (m as { userId: Types.ObjectId }).userId.equals(
                  filter.userId as Types.ObjectId,
                ) &&
                (filter.status === undefined ||
                  (m as { status: string }).status === filter.status),
            ),
          ),
      })),
    };
    organizationModel = {
      findById: jest.fn((id: Types.ObjectId) => ({
        exec: (): Promise<unknown> => {
          orgByIdCalls.push(id);
          const index = organizationDb.findIndex((o) =>
            (o as { _id: Types.ObjectId })._id.equals(id),
          );
          return Promise.resolve(index === -1 ? null : organizationDb[index]);
        },
      })),
    };
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
        {
          provide: getModelToken(OrganizationInvitation.name),
          useValue: {},
        },
        { provide: UsersService, useValue: { findByEmail: jest.fn() } },
        { provide: getConnectionToken(), useValue: {} },
        {
          provide: SocketRegistryService,
          useValue: { disconnectMember: jest.fn() },
        },
        { provide: S3Service, useValue: s3ServiceStub },
      ],
    }).compile();
    service = module.get(OrganizationsService);
  }

  function membershipWith(
    orgIdHex: string,
    status: MembershipStatus = MembershipStatus.ACTIVE,
  ) {
    return {
      _id: new Types.ObjectId(MEMBERSHIP_OBJECT_ID),
      userId: new Types.ObjectId(USER_OBJECT_ID),
      organizationId: new Types.ObjectId(orgIdHex),
      role: OrganizationRole.SELLER,
      permissions: ['sales.view_all'] as DelegablePermission[],
      status,
    };
  }

  function orgWith(
    idHex: string,
    name: string,
    status: OrganizationStatus = OrganizationStatus.ACTIVE,
  ) {
    return {
      _id: new Types.ObjectId(idHex),
      name,
      status,
    };
  }

  // Constantes déterministes (hexadécimales canoniques)
  const ORG_1 = '111111111111111111111111';
  const ORG_2 = '222222222222222222222222';
  const ORG_3 = '333333333333333333333333';

  // 1. recherche uniquement les memberships de l'utilisateur, status active
  it('la requête membership filtre { userId, status: active } en ObjectId', async () => {
    await buildList();
    membershipDb = [
      membershipWith(ORG_1),
      // membership d'autre utilisateur : EXCLUE par le filtre userId.
      {
        ...membershipWith(ORG_1),
        userId: new Types.ObjectId('999999999999999999999999'),
      },
    ];
    organizationDb = [orgWith(ORG_1, 'Solo')];

    const result = await service.listActiveOrganizations(USER_OBJECT_ID);

    const filter = membershipModel.find.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(filter).sort()).toEqual(['status', 'userId']);
    expect(filter.userId).toBeInstanceOf(Types.ObjectId);
    expect((filter.userId as Types.ObjectId).toString()).toBe(USER_OBJECT_ID);
    expect(filter.status).toBe(MembershipStatus.ACTIVE);
    expect('organizationId' in filter).toBe(false);
    // Seul l'org de l'utilisateur est présent dans le résultat :
    expect(result.map((o) => o.organizationId)).toEqual([ORG_1]);
  });

  // 2. recherche uniquement les organisations actives correspondantes
  it('chaque organisation est recherchée avec l’ID de la membership (findById)', async () => {
    await buildList();
    membershipDb = [membershipWith(ORG_1), membershipWith(ORG_2)];
    organizationDb = [orgWith(ORG_1, 'Alpha'), orgWith(ORG_2, 'Beta')];

    const result = await service.listActiveOrganizations(USER_OBJECT_ID);

    expect(orgByIdCalls).toHaveLength(2);
    expect((orgByIdCalls[0] as Types.ObjectId).toString()).toBe(ORG_1);
    expect((orgByIdCalls[1] as Types.ObjectId).toString()).toBe(ORG_2);
    expect(result.map((o) => o.organizationId).sort()).toEqual([ORG_1, ORG_2]);
  });

  // 3. membership suspendue/révoquée exclue
  it.each([
    ['suspendue', MembershipStatus.SUSPENDED],
    ['révoquée', MembershipStatus.REVOKED],
  ])('membership %s → exclue du résultat', async (_label, status) => {
    await buildList();
    membershipDb = [
      membershipWith(ORG_1, status),
      membershipWith(ORG_2, MembershipStatus.ACTIVE),
    ];
    organizationDb = [orgWith(ORG_1, 'Suspended'), orgWith(ORG_2, 'Active')];

    const result = await service.listActiveOrganizations(USER_OBJECT_ID);

    expect(result.map((o) => o.organizationId)).toEqual([ORG_2]);
  });

  // 4. organisation absente ou suspendue exclue
  it('organisation ABSENTE → exclue du résultat', async () => {
    await buildList();
    membershipDb = [membershipWith(ORG_1), membershipWith(ORG_2)];
    // ORG_1 absente de la base : lookup → null.
    organizationDb = [orgWith(ORG_2, 'Present')];

    const result = await service.listActiveOrganizations(USER_OBJECT_ID);

    expect(result.map((o) => o.organizationId)).toEqual([ORG_2]);
    expect(orgByIdCalls).toHaveLength(2);
  });

  it('organisation SUSPENDUE → exclue du résultat', async () => {
    await buildList();
    membershipDb = [membershipWith(ORG_1), membershipWith(ORG_2)];
    organizationDb = [
      orgWith(ORG_1, 'SuspendedOrg', OrganizationStatus.SUSPENDED),
      orgWith(ORG_2, 'ActiveOrg'),
    ];

    const result = await service.listActiveOrganizations(USER_OBJECT_ID);

    expect(result.map((o) => o.organizationId)).toEqual([ORG_2]);
  });

  // 5. résultat minimal { organizationId, name } uniquement
  it('chaque résultat porte exactement { organizationId, name }', async () => {
    await buildList();
    membershipDb = [membershipWith(ORG_1)];
    organizationDb = [orgWith(ORG_1, 'Solo')];

    const result = await service.listActiveOrganizations(USER_OBJECT_ID);

    expect(result).toHaveLength(1);
    expect(Object.keys(result[0]).sort()).toEqual(['name', 'organizationId']);
    expect(result[0]).toEqual({ organizationId: ORG_1, name: 'Solo' });
  });

  // 6. aucune permission ni membershipId exposé
  it('aucune permission ni membershipId ni autre champ sensible exposé', async () => {
    await buildList();
    membershipDb = [membershipWith(ORG_1)];
    organizationDb = [orgWith(ORG_1, 'NoLeak')];

    const result = await service.listActiveOrganizations(USER_OBJECT_ID);
    const first = result[0] as Record<string, unknown>;

    expect('permissions' in first).toBe(false);
    expect('membershipId' in first).toBe(false);
    expect('role' in first).toBe(false);
    expect('status' in first).toBe(false);
    expect('userId' in first).toBe(false);
  });

  // 7. tri déterministe par nom (critère principal)
  it('tri principal par name (entrée désordonnée → sortie triée)', async () => {
    await buildList();
    membershipDb = [
      membershipWith(ORG_2),
      membershipWith(ORG_1),
      membershipWith(ORG_3),
    ];
    organizationDb = [
      orgWith(ORG_2, 'Charlie'),
      orgWith(ORG_1, 'Alpha'),
      orgWith(ORG_3, 'Bravo'),
    ];

    const result = await service.listActiveOrganizations(USER_OBJECT_ID);

    expect(result.map((o) => o.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  // 8. deux organisations de même nom départagées par organizationId
  it('mêmes noms → départage par organizationId (ordre hexadécimal croissant)', async () => {
    await buildList();
    // Entrée volontairement dans l'ordre inverse du tri attendu : prouve que
    // le résultat ne dépend ni de l'ordre de la base ni de la stabilité du tri.
    membershipDb = [membershipWith(ORG_2), membershipWith(ORG_1)];
    organizationDb = [orgWith(ORG_2, 'Dup'), orgWith(ORG_1, 'Dup')];

    const result = await service.listActiveOrganizations(USER_OBJECT_ID);

    expect(result.map((o) => o.organizationId)).toEqual([ORG_1, ORG_2]);
  });

  // 9. documents/permissions retournés non mutés
  it('les documents source ne sont pas mutés par la réponse', async () => {
    await buildList();
    const mem = membershipWith(ORG_1);
    mem.permissions = ['sales.view_all', 'analytics.read'];
    const orgDoc = orgWith(ORG_1, 'Immut');
    membershipDb = [mem];
    organizationDb = [orgDoc];

    const result = await service.listActiveOrganizations(USER_OBJECT_ID);

    // Mutation du RÉSULTAT : le document source de l'organisation n'est PAS
    // affecté (l'objet renvoyé est une nouvelle vue minimale).
    (result[0] as Record<string, unknown>).name = 'MUTATED';
    expect(orgDoc.name).toBe('Immut');
    // Les permissions du document de membership demeurent intactes :
    expect(mem.permissions).toEqual(['sales.view_all', 'analytics.read']);
  });

  // 10. aucune organisation accessible → tableau vide
  it('aucune membership active → tableau vide (aucune recherche org)', async () => {
    await buildList();
    membershipDb = [membershipWith(ORG_1, MembershipStatus.REVOKED)];
    organizationDb = [orgWith(ORG_1, 'Ghost')];

    const result = await service.listActiveOrganizations(USER_OBJECT_ID);

    expect(result).toEqual([]);
    // Le filtre actif de la base exclut la membership : aucune recherche org.
    expect(organizationModel.findById).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Invitations (phase 1-6B.1) — émission, liste, révocation
// =============================================================================
describe('OrganizationsService — invitations (1-6B.1)', () => {
  const OWNER_ID = '445566778899001122334455';
  const INVITATION_ID = '556677889900112233445566';
  const OTHER_ORG_ID = '667788990011223344556677';
  const crypto = jest.requireActual<typeof import('crypto')>('crypto');

  let service: OrganizationsService;
  let invitationModel: {
    findOne: jest.Mock;
    create: jest.Mock;
    find: jest.Mock;
    findOneAndUpdate: jest.Mock;
  };
  let membershipModel: { findOne: jest.Mock };
  let usersService: { findByEmail: jest.Mock };
  // Dispatch par userId (chaîne) : l'acteur (`invitedById`) ET l'éventuelle
  // membership active d'un email déjà membre (`existingUser._id`) partagent
  // le même modèle mais ne sont JAMAIS le même document dans les tests —
  // un `jest.fn()` unique ne peut plus distinguer les deux requêtes depuis
  // la correction anti-escalade (1-9C), qui relit l'acteur EN PREMIER.
  let membershipByUserId: Map<string, Record<string, unknown> | null>;

  function invitationDoc(overrides: Record<string, unknown> = {}) {
    return {
      _id: new Types.ObjectId(INVITATION_ID),
      email: 'invite@example.com',
      role: OrganizationRole.ADMIN,
      permissions: [] as DelegablePermission[],
      status: 'pending',
      expiresAt: new Date('2026-01-04T00:00:00.000Z'),
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  // Acteur par défaut de toutes les invitations préexistantes : `owner`
  // actif (contourne l'anti-escalade, même convention que `updateMembership`).
  function ownerActor(): Record<string, unknown> {
    return {
      role: OrganizationRole.OWNER,
      permissions: [] as DelegablePermission[],
      status: MembershipStatus.ACTIVE,
    };
  }

  async function build() {
    invitationModel = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
      create: jest.fn((doc: Record<string, unknown>) =>
        Promise.resolve(invitationDoc(doc)),
      ),
      find: jest.fn(() => ({
        sort: () => ({ exec: () => Promise.resolve([]) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    membershipByUserId = new Map([[OWNER_ID, ownerActor()]]);
    membershipModel = {
      findOne: jest.fn((query: { userId: { toString(): string } }) => ({
        exec: () =>
          Promise.resolve(
            membershipByUserId.get(query.userId.toString()) ?? null,
          ),
      })),
    };
    usersService = { findByEmail: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsService,
        { provide: getModelToken(Organization.name), useValue: {} },
        {
          provide: getModelToken(OrganizationMembership.name),
          useValue: membershipModel,
        },
        {
          provide: getModelToken(OrganizationInvitation.name),
          useValue: invitationModel,
        },
        { provide: UsersService, useValue: usersService },
        { provide: getConnectionToken(), useValue: {} },
        {
          provide: SocketRegistryService,
          useValue: { disconnectMember: jest.fn() },
        },
        { provide: S3Service, useValue: s3ServiceStub },
      ],
    }).compile();
    service = module.get(OrganizationsService);
  }

  const NOW = new Date('2026-01-01T00:00:00.000Z');
  const VALID_DTO = {
    email: 'Invite@Example.com',
    role: OrganizationRole.ADMIN,
  };

  describe('createInvitation', () => {
    it('normalise l’email (lowercase/trim) et renvoie un token ≠ au hash stocké', async () => {
      await build();
      const result = await service.createInvitation(
        ORG_OBJECT_ID,
        OWNER_ID,
        VALID_DTO,
        NOW,
      );

      const created = invitationModel.create.mock.calls[0][0] as {
        email: string;
        tokenHash: string;
      };
      expect(created.email).toBe('invite@example.com');
      expect(result.token).not.toBe(created.tokenHash);
      // Hash EXACT SHA-256 du token brut renvoyé :
      const expectedHash = crypto
        .createHash('sha256')
        .update(result.token)
        .digest('hex');
      expect(created.tokenHash).toBe(expectedHash);
      expect(created.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('expiration calculée serveur : exactement +72h de `now`', async () => {
      await build();
      await service.createInvitation(ORG_OBJECT_ID, OWNER_ID, VALID_DTO, NOW);
      const created = invitationModel.create.mock.calls[0][0] as {
        expiresAt: Date;
      };
      expect(created.expiresAt.getTime() - NOW.getTime()).toBe(
        72 * 60 * 60 * 1000,
      );
    });

    it('réponse : { invitation, token } — jamais tokenHash/invitedById', async () => {
      await build();
      const result = await service.createInvitation(
        ORG_OBJECT_ID,
        OWNER_ID,
        VALID_DTO,
        NOW,
      );
      expect(Object.keys(result).sort()).toEqual(['invitation', 'token']);
      expect(Object.keys(result.invitation).sort()).toEqual([
        '_id',
        'email',
        'expiresAt',
        'permissions',
        'role',
        'status',
      ]);
    });

    it('email avec membership active existante dans CETTE org → 409 MEMBER_ALREADY_ACTIVE', async () => {
      await build();
      const existingUserId = '998877665544332211009988';
      usersService.findByEmail.mockResolvedValue({
        _id: new Types.ObjectId(existingUserId),
      });
      // Distinct de l'acteur (`OWNER_ID`, déjà `owner` actif par défaut) —
      // sinon la même clé de dispatch masquerait la relecture de l'acteur.
      membershipByUserId.set(existingUserId, {
        status: MembershipStatus.ACTIVE,
      });

      const error: unknown = await service
        .createInvitation(ORG_OBJECT_ID, OWNER_ID, VALID_DTO, NOW)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'MEMBER_ALREADY_ACTIVE',
      });
      expect(invitationModel.create).not.toHaveBeenCalled();
    });

    it('invitation `pending` non expirée pour le même email → 409 INVITATION_ALREADY_PENDING', async () => {
      await build();
      invitationModel.findOne.mockReturnValue({
        exec: () =>
          Promise.resolve(
            invitationDoc({ expiresAt: new Date('2099-01-01T00:00:00.000Z') }),
          ),
      });

      const error: unknown = await service
        .createInvitation(ORG_OBJECT_ID, OWNER_ID, VALID_DTO, NOW)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'INVITATION_ALREADY_PENDING',
      });
      expect(invitationModel.create).not.toHaveBeenCalled();
    });

    it('invitation `pending` EXPIRÉE → marquée `expired` puis une nouvelle est émise', async () => {
      await build();
      const expired = invitationDoc({
        expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      });
      invitationModel.findOne.mockReturnValue({
        exec: () => Promise.resolve(expired),
      });

      await service.createInvitation(ORG_OBJECT_ID, OWNER_ID, VALID_DTO, NOW);

      expect(expired.status).toBe(InvitationStatus.EXPIRED);
      expect(expired.save).toHaveBeenCalledTimes(1);
      expect(invitationModel.create).toHaveBeenCalledTimes(1);
    });

    // 1-6B.2 : course concurrente sur l'index unique partiel — le pré-check
    // `findOne` ne protège pas contre 2 émissions simultanées.
    it('E11000 concurrent sur `create` → 409 INVITATION_ALREADY_PENDING (jamais 500)', async () => {
      await build();
      const duplicateError = Object.assign(new Error('E11000 duplicate key'), {
        code: 11000,
      });
      invitationModel.create.mockRejectedValue(duplicateError);

      const error: unknown = await service
        .createInvitation(ORG_OBJECT_ID, OWNER_ID, VALID_DTO, NOW)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'INVITATION_ALREADY_PENDING',
      });
    });

    it('permissions omises → [] par défaut', async () => {
      await build();
      await service.createInvitation(ORG_OBJECT_ID, OWNER_ID, VALID_DTO, NOW);
      const created = invitationModel.create.mock.calls[0][0] as {
        permissions: unknown[];
      };
      expect(created.permissions).toEqual([]);
    });

    // ---- CORRECTION SÉCURITÉ (1-9C) : anti-escalade des invitations ----
    // `PermissionGuard` ne vérifie QUE `members.invite` ; jamais que le
    // rôle/permissions DE L'INVITATION restent dans les droits de l'acteur.
    // L'acteur est RELU ici (jamais depuis le body/JWT), donc chaque
    // scénario contrôle son ID d'acteur explicitement (jamais `OWNER_ID`
    // implicite) et vérifie ZÉRO écriture en cas de refus.
    describe('anti-escalade — rôle/permissions de l’invitation ⊆ droits de l’acteur', () => {
      const ADMIN_ACTOR_ID = '111122223333444455556666';
      const SELLER_INVITER_ID = '222233334444555566667777';
      const SELLER_PLAIN_ID = '333344445555666677778888';

      it('owner invite admin (permissions par défaut) → succès', async () => {
        await build();
        const result = await service.createInvitation(
          ORG_OBJECT_ID,
          OWNER_ID,
          { email: 'admin@example.com', role: OrganizationRole.ADMIN },
          NOW,
        );
        expect(result.invitation.role).toBe(OrganizationRole.ADMIN);
        expect(invitationModel.create).toHaveBeenCalledTimes(1);
      });

      it('admin invite seller dans ses droits (admin = tout le délégable par défaut) → succès', async () => {
        await build();
        membershipByUserId.set(ADMIN_ACTOR_ID, {
          role: OrganizationRole.ADMIN,
          permissions: [] as DelegablePermission[],
          status: MembershipStatus.ACTIVE,
        });
        const result = await service.createInvitation(
          ORG_OBJECT_ID,
          ADMIN_ACTOR_ID,
          {
            email: 'seller@example.com',
            role: OrganizationRole.SELLER,
            permissions: ['analytics.read'] as DelegablePermission[],
          },
          NOW,
        );
        expect(result.invitation.role).toBe(OrganizationRole.SELLER);
        expect(invitationModel.create).toHaveBeenCalledTimes(1);
      });

      it('seller délégué members.invite SEUL tente d’inviter role=admin → 403 PERMISSION_DENIED, zéro écriture', async () => {
        await build();
        membershipByUserId.set(SELLER_INVITER_ID, {
          role: OrganizationRole.SELLER,
          permissions: ['members.invite'] as DelegablePermission[],
          status: MembershipStatus.ACTIVE,
        });

        const error: unknown = await service
          .createInvitation(
            ORG_OBJECT_ID,
            SELLER_INVITER_ID,
            { email: 'escalated@example.com', role: OrganizationRole.ADMIN },
            NOW,
          )
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getStatus()).toBe(403);
        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: 'PERMISSION_DENIED',
        });
        expect(invitationModel.create).not.toHaveBeenCalled();
        // Aucune lecture d'email/pending n'a même lieu : le refus intervient
        // AVANT toute autre logique métier.
        expect(usersService.findByEmail).not.toHaveBeenCalled();
      });

      it('seller tente de déléguer une permission qu’il ne possède pas lui-même → 403, zéro écriture', async () => {
        await build();
        membershipByUserId.set(SELLER_INVITER_ID, {
          role: OrganizationRole.SELLER,
          permissions: ['members.invite'] as DelegablePermission[],
          status: MembershipStatus.ACTIVE,
        });

        const error: unknown = await service
          .createInvitation(
            ORG_OBJECT_ID,
            SELLER_INVITER_ID,
            {
              email: 'over-privileged@example.com',
              role: OrganizationRole.SELLER,
              permissions: ['members.manage'] as DelegablePermission[],
            },
            NOW,
          )
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: 'PERMISSION_DENIED',
        });
        expect(invitationModel.create).not.toHaveBeenCalled();
      });

      it('seller invite un seller avec un sous-ensemble strictement autorisé de ses propres permissions → succès', async () => {
        await build();
        membershipByUserId.set(SELLER_INVITER_ID, {
          role: OrganizationRole.SELLER,
          permissions: [
            'members.invite',
            'analytics.read',
          ] as DelegablePermission[],
          status: MembershipStatus.ACTIVE,
        });

        const result = await service.createInvitation(
          ORG_OBJECT_ID,
          SELLER_INVITER_ID,
          {
            email: 'peer@example.com',
            role: OrganizationRole.SELLER,
            permissions: ['analytics.read'] as DelegablePermission[],
          },
          NOW,
        );

        expect(result.invitation.role).toBe(OrganizationRole.SELLER);
        expect(invitationModel.create).toHaveBeenCalledTimes(1);
      });

      it('acteur sans members.invite (permission absente) → 403 PERMISSION_DENIED, zéro écriture', async () => {
        await build();
        membershipByUserId.set(SELLER_PLAIN_ID, {
          role: OrganizationRole.SELLER,
          permissions: [] as DelegablePermission[],
          status: MembershipStatus.ACTIVE,
        });

        const error: unknown = await service
          .createInvitation(
            ORG_OBJECT_ID,
            SELLER_PLAIN_ID,
            { email: 'x@example.com', role: OrganizationRole.SELLER },
            NOW,
          )
          .catch((e: unknown) => e);

        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: 'PERMISSION_DENIED',
        });
        expect(invitationModel.create).not.toHaveBeenCalled();
      });

      it('acteur absent (aucune membership dans cette organisation) → 403 PERMISSION_DENIED, zéro écriture', async () => {
        await build();
        const error: unknown = await service
          .createInvitation(
            ORG_OBJECT_ID,
            '999988887777666655554444',
            { email: 'x@example.com', role: OrganizationRole.SELLER },
            NOW,
          )
          .catch((e: unknown) => e);

        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: 'PERMISSION_DENIED',
        });
        expect(invitationModel.create).not.toHaveBeenCalled();
      });

      it('acteur inactif (membership suspendue) → 403 PERMISSION_DENIED, zéro écriture', async () => {
        await build();
        membershipByUserId.set(SELLER_PLAIN_ID, {
          role: OrganizationRole.SELLER,
          permissions: ['members.invite'] as DelegablePermission[],
          status: MembershipStatus.SUSPENDED,
        });

        const error: unknown = await service
          .createInvitation(
            ORG_OBJECT_ID,
            SELLER_PLAIN_ID,
            { email: 'x@example.com', role: OrganizationRole.SELLER },
            NOW,
          )
          .catch((e: unknown) => e);

        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: 'PERMISSION_DENIED',
        });
        expect(invitationModel.create).not.toHaveBeenCalled();
      });
    });
  });

  describe('listInvitations', () => {
    it('filtre par organizationId uniquement, tri createdAt desc, jamais tokenHash', async () => {
      await build();
      const sortSpy = jest.fn(() => ({
        exec: () => Promise.resolve([invitationDoc()]),
      }));
      invitationModel.find.mockReturnValue({ sort: sortSpy });

      const result = await service.listInvitations(ORG_OBJECT_ID);

      expect(invitationModel.find).toHaveBeenCalledWith({
        organizationId: new Types.ObjectId(ORG_OBJECT_ID),
      });
      expect(sortSpy).toHaveBeenCalledWith({ createdAt: -1 });
      expect(result).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain('tokenHash');
    });
  });

  describe('revokeInvitation', () => {
    it('filtre exact { _id, organizationId, status: pending }', async () => {
      await build();
      invitationModel.findOneAndUpdate.mockReturnValue({
        exec: () => Promise.resolve(invitationDoc()),
      });

      await service.revokeInvitation(ORG_OBJECT_ID, INVITATION_ID);

      expect(invitationModel.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: new Types.ObjectId(INVITATION_ID),
          organizationId: new Types.ObjectId(ORG_OBJECT_ID),
          status: InvitationStatus.PENDING,
        },
        { status: InvitationStatus.REVOKED },
        { new: true },
      );
    });

    it('invitation étrangère (autre org) ou absente → même 404', async () => {
      await build(); // findOneAndUpdate résout null par défaut

      const foreign: unknown = await service
        .revokeInvitation(OTHER_ORG_ID, INVITATION_ID)
        .catch((e: unknown) => e);
      const missing: unknown = await service
        .revokeInvitation(ORG_OBJECT_ID, INVITATION_ID)
        .catch((e: unknown) => e);

      expect(foreign).toBeInstanceOf(NotFoundException);
      expect(missing).toBeInstanceOf(NotFoundException);
      expect((foreign as NotFoundException).getStatus()).toBe(
        (missing as NotFoundException).getStatus(),
      );
    });
  });
});

// =============================================================================
// acceptInvitation (phase 1-6B.2) — acceptation atomique
// =============================================================================
describe('OrganizationsService.acceptInvitation (1-6B.2)', () => {
  const ORG_ID = '778899001122334455667788';
  const USER_ID = '889900112233445566778899';
  const MEMBERSHIP_ID = '990011223344556677889900';
  const INVITER_ID = 'aa0011223344556677889900';
  const NOW = new Date('2026-01-01T00:00:00.000Z');
  const RAW_TOKEN = 'raw-token-value';

  let service: OrganizationsService;
  let invitationModel: { findOneAndUpdate: jest.Mock };
  let organizationModel: { findById: jest.Mock };
  let membershipModel: {
    findOne: jest.Mock;
    create: jest.Mock;
    countDocuments: jest.Mock;
  };
  let usersService: { findByEmail: jest.Mock; create: jest.Mock };
  let connectionFixture: {
    session: { withTransaction: jest.Mock; endSession: jest.Mock };
    connection: { startSession: jest.Mock };
    endSession: jest.Mock;
  };

  function invitationDoc(overrides: Record<string, unknown> = {}) {
    return {
      _id: new Types.ObjectId(INVITATION_ID_FOR_ACCEPT),
      organizationId: new Types.ObjectId(ORG_ID),
      email: 'invitee@example.com',
      role: OrganizationRole.ADMIN,
      permissions: ['analytics.read'] as DelegablePermission[],
      invitedById: new Types.ObjectId(INVITER_ID),
      status: InvitationStatus.PENDING,
      expiresAt: new Date('2026-01-04T00:00:00.000Z'),
      ...overrides,
    };
  }
  const INVITATION_ID_FOR_ACCEPT = 'bb0011223344556677889900';

  function organizationDoc(overrides: Record<string, unknown> = {}) {
    return {
      _id: new Types.ObjectId(ORG_ID),
      name: 'Acme',
      slug: 'acme-1234',
      status: OrganizationStatus.ACTIVE,
      ...overrides,
    };
  }

  function makeConnectionFixture() {
    const endSession = jest.fn().mockResolvedValue(true);
    const withTransaction = jest.fn(
      async (cb: (s: unknown) => Promise<unknown>) => cb(sessionRef),
    );
    const sessionRef = { withTransaction, endSession };
    const connection = {
      startSession: jest.fn(() => Promise.resolve(sessionRef)),
    };
    return { session: sessionRef, connection, endSession };
  }

  async function build() {
    invitationModel = {
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(invitationDoc()),
      })),
    };
    organizationModel = {
      findById: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(organizationDoc()) }),
      })),
    };
    membershipModel = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(null) }),
      })),
      create: jest.fn((docs: Record<string, unknown>[]) =>
        Promise.resolve([
          {
            _id: new Types.ObjectId(MEMBERSHIP_ID),
            organizationId: docs[0].organizationId,
            userId: docs[0].userId,
            role: docs[0].role,
            permissions: docs[0].permissions,
            invitedById: docs[0].invitedById,
            status: MembershipStatus.ACTIVE,
          },
        ]),
      ),
      countDocuments: jest.fn().mockResolvedValue(1),
    };
    usersService = {
      findByEmail: jest.fn().mockResolvedValue(null),
      create: jest.fn((data: Record<string, unknown>) =>
        Promise.resolve({
          _id: new Types.ObjectId(USER_ID),
          name: data.name,
          email: data.email,
          password: data.password,
          role: data.role,
        }),
      ),
    };
    connectionFixture = makeConnectionFixture();

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
        {
          provide: getModelToken(OrganizationInvitation.name),
          useValue: invitationModel,
        },
        { provide: UsersService, useValue: usersService },
        {
          provide: getConnectionToken(),
          useValue: connectionFixture.connection,
        },
        {
          provide: SocketRegistryService,
          useValue: { disconnectMember: jest.fn() },
        },
        { provide: S3Service, useValue: s3ServiceStub },
      ],
    }).compile();
    service = module.get(OrganizationsService);
  }

  const VALID_DTO = {
    token: RAW_TOKEN,
    name: 'Ada',
    password: 'secret-123',
  };

  it('user absent : crée le triplet atomique, password hashé, User.role = seller', async () => {
    await build();
    const result = await service.acceptInvitation(VALID_DTO, NOW);

    expect(usersService.create).toHaveBeenCalledTimes(1);
    const created = usersService.create.mock.calls[0][0] as {
      password: string;
      role: string;
    };
    expect(created.role).toBe(UserRole.SELLER);
    expect(created.password).not.toBe('secret-123');
    await expect(bcrypt.compare('secret-123', created.password)).resolves.toBe(
      true,
    );
    expect(membershipModel.create).toHaveBeenCalledTimes(1);
    expect(result.user.email).toBe('invitee@example.com');
    expect(connectionFixture.session.endSession).toHaveBeenCalledTimes(1);
  });

  it("une invitation `role: admin` NE promeut JAMAIS User.role à admin (pas d'escalade globale)", async () => {
    await build();
    await service.acceptInvitation(VALID_DTO, NOW); // invitation par défaut : role admin
    const created = usersService.create.mock.calls[0][0] as { role: string };
    expect(created.role).toBe(UserRole.SELLER);
    expect(created.role).not.toBe(UserRole.ADMIN);
  });

  it('user existant : aucune modification (create jamais appelé, membership reçoit son userId)', async () => {
    await build();
    const existing = {
      _id: new Types.ObjectId(USER_ID),
      name: 'Existing',
      email: 'invitee@example.com',
      password: 'already-hashed',
      role: UserRole.SELLER,
    };
    usersService.findByEmail.mockResolvedValue(existing);

    const result = await service.acceptInvitation({ token: RAW_TOKEN }, NOW);

    expect(usersService.create).not.toHaveBeenCalled();
    expect(result.user.name).toBe('Existing');
    const createdMembership = membershipModel.create.mock.calls[0][0][0] as {
      userId: unknown;
    };
    expect(createdMembership.userId).toBe(existing._id);
  });

  it('rôle/permissions/invitedById copiés EXACTEMENT depuis l’invitation', async () => {
    await build();
    await service.acceptInvitation(VALID_DTO, NOW);
    const created = membershipModel.create.mock.calls[0][0][0] as {
      role: string;
      permissions: string[];
      invitedById: unknown;
      organizationId: unknown;
    };
    expect(created.role).toBe(OrganizationRole.ADMIN);
    expect(created.permissions).toEqual(['analytics.read']);
    expect(created.invitedById?.toString()).toBe(INVITER_ID);
    expect(created.organizationId?.toString()).toBe(ORG_ID);
  });

  it('hash SHA-256 exact du token utilisé dans le filtre de réclamation', async () => {
    await build();
    await service.acceptInvitation(VALID_DTO, NOW);
    const expectedHash = createHash('sha256').update(RAW_TOKEN).digest('hex');
    const filter = invitationModel.findOneAndUpdate.mock.calls[0][0] as {
      tokenHash: string;
      status: string;
      expiresAt: { $gt: Date };
    };
    expect(filter.tokenHash).toBe(expectedHash);
    expect(filter.status).toBe(InvitationStatus.PENDING);
    expect(filter.expiresAt.$gt).toBe(NOW);
  });

  it.each([['inconnu (aucun match)', null]])(
    'token %s → 400 INVITATION_INVALID_OR_EXPIRED, zéro écriture',
    async (_label, resolved) => {
      await build();
      invitationModel.findOneAndUpdate.mockReturnValue({
        exec: () => Promise.resolve(resolved),
      });

      const error: unknown = await service
        .acceptInvitation(VALID_DTO, NOW)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: INVITATION_INVALID_OR_EXPIRED,
      });
      expect(usersService.create).not.toHaveBeenCalled();
      expect(membershipModel.create).not.toHaveBeenCalled();
    },
  );

  it('organisation absente → même 400 générique (aucune écriture Membership)', async () => {
    await build();
    organizationModel.findById.mockReturnValue({
      session: () => ({ exec: () => Promise.resolve(null) }),
    });

    const error: unknown = await service
      .acceptInvitation(VALID_DTO, NOW)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: INVITATION_INVALID_OR_EXPIRED,
    });
    expect(membershipModel.create).not.toHaveBeenCalled();
  });

  it('organisation suspendue → même 400 générique', async () => {
    await build();
    organizationModel.findById.mockReturnValue({
      session: () => ({
        exec: () =>
          Promise.resolve(
            organizationDoc({ status: OrganizationStatus.SUSPENDED }),
          ),
      }),
    });

    const error: unknown = await service
      .acceptInvitation(VALID_DTO, NOW)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: INVITATION_INVALID_OR_EXPIRED,
    });
  });

  it('name/password manquants pour un user absent → 400 ACCOUNT_DETAILS_REQUIRED', async () => {
    await build();
    const error: unknown = await service
      .acceptInvitation({ token: RAW_TOKEN }, NOW)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'ACCOUNT_DETAILS_REQUIRED',
    });
    expect(membershipModel.create).not.toHaveBeenCalled();
  });

  it('membership déjà existante (même inactive) → 409 stable, AUCUNE réactivation', async () => {
    await build();
    const existingUser = {
      _id: new Types.ObjectId(USER_ID),
      name: 'X',
      email: 'invitee@example.com',
    };
    usersService.findByEmail.mockResolvedValue(existingUser);
    membershipModel.findOne.mockReturnValue({
      session: () => ({
        exec: () => Promise.resolve({ status: MembershipStatus.REVOKED }),
      }),
    });

    const error: unknown = await service
      .acceptInvitation({ token: RAW_TOKEN }, NOW)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'MEMBERSHIP_ALREADY_EXISTS',
    });
    expect(membershipModel.create).not.toHaveBeenCalled();
  });

  it('réponse exacte : user/organization/membership minimaux, aucune donnée sensible', async () => {
    await build();
    const result = await service.acceptInvitation(VALID_DTO, NOW);
    expect(Object.keys(result).sort()).toEqual([
      'membership',
      'organization',
      'user',
    ]);
    expect(Object.keys(result.user).sort()).toEqual(['_id', 'email', 'name']);
    expect(Object.keys(result.organization).sort()).toEqual([
      '_id',
      'name',
      'slug',
    ]);
    expect(Object.keys(result.membership).sort()).toEqual(['role', 'status']);
    const flat = JSON.stringify(result);
    expect(flat).not.toContain('password');
    expect(flat).not.toContain('access_token');
    expect(flat).not.toContain('tokenHash');
    expect(flat).not.toContain('invitedById');
  });

  it('garde défensive finale (invariant membership) → rollback, session fermée', async () => {
    await build();
    membershipModel.countDocuments.mockResolvedValue(2);

    await expect(service.acceptInvitation(VALID_DTO, NOW)).rejects.toThrow();
    expect(connectionFixture.session.endSession).toHaveBeenCalledTimes(1);
  });

  it('endSession() appelé même en échec (finally)', async () => {
    await build();
    invitationModel.findOneAndUpdate.mockReturnValue({
      exec: () => Promise.resolve(null),
    });

    await service.acceptInvitation(VALID_DTO, NOW).catch(() => undefined);
    expect(connectionFixture.session.endSession).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 1-7C — gestion des membres + transfert de propriété
// =============================================================================

const ORG_ID_17C = 'aa1122334455667788990011';
const ACTOR_USER_ID = 'bb1122334455667788990011';
const ACTOR_MEMBERSHIP_ID = 'cc1122334455667788990011';
const TARGET_USER_ID = 'dd1122334455667788990011';
const TARGET_MEMBERSHIP_ID = 'ee1122334455667788990011';

/** Chaîne de requête Mongoose minimale : `populate`/`sort`/`session` chaînables, `exec` résout `result`. */
function makeChain(result: unknown) {
  const chain: Record<string, jest.Mock> = {};
  chain.populate = jest.fn(() => chain);
  chain.sort = jest.fn(() => chain);
  chain.session = jest.fn(() => chain);
  chain.exec = jest.fn().mockResolvedValue(result);
  return chain;
}

function populatedUser(userId: string, name = 'U', email = 'u@example.com') {
  return { _id: new Types.ObjectId(userId), name, email };
}

function membershipDoc(
  userId: string,
  membershipId: string,
  overrides: Record<string, unknown> = {},
) {
  const doc: Record<string, unknown> = {
    _id: new Types.ObjectId(membershipId),
    organizationId: new Types.ObjectId(ORG_ID_17C),
    userId: populatedUser(userId),
    role: OrganizationRole.SELLER,
    permissions: [] as DelegablePermission[],
    status: MembershipStatus.ACTIVE,
    joinedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
  doc.save = jest.fn().mockResolvedValue(doc);
  return doc;
}

function makeSessionFixture17C() {
  const endSession = jest.fn().mockResolvedValue(true);
  const withTransaction = jest.fn(
    async (cb: (s: unknown) => Promise<unknown>) => cb(sessionRef),
  );
  const sessionRef = { withTransaction, endSession };
  const connection = {
    startSession: jest.fn(() => Promise.resolve(sessionRef)),
  };
  return { session: sessionRef, connection, endSession };
}

describe('OrganizationsService.listMembers (1-7C)', () => {
  let service: OrganizationsService;
  let membershipModel: { find: jest.Mock };

  async function build(members: unknown[]) {
    membershipModel = { find: jest.fn(() => makeChain(members)) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsService,
        { provide: getModelToken(Organization.name), useValue: {} },
        {
          provide: getModelToken(OrganizationMembership.name),
          useValue: membershipModel,
        },
        { provide: getModelToken(OrganizationInvitation.name), useValue: {} },
        { provide: UsersService, useValue: {} },
        { provide: getConnectionToken(), useValue: {} },
        {
          provide: SocketRegistryService,
          useValue: { disconnectMember: jest.fn() },
        },
        { provide: S3Service, useValue: s3ServiceStub },
      ],
    }).compile();
    service = module.get(OrganizationsService);
  }

  it('filtre EXACTEMENT par organizationId (org B jamais incluse) et ne renvoie jamais password/User.role', async () => {
    const member = membershipDoc(TARGET_USER_ID, TARGET_MEMBERSHIP_ID);
    await build([member]);

    const result = await service.listMembers(ORG_ID_17C);

    expect(membershipModel.find).toHaveBeenCalledWith({
      organizationId: new Types.ObjectId(ORG_ID_17C),
    });
    expect(result).toEqual([
      {
        membershipId: TARGET_MEMBERSHIP_ID,
        user: { _id: TARGET_USER_ID, name: 'U', email: 'u@example.com' },
        role: OrganizationRole.SELLER,
        permissions: [],
        status: MembershipStatus.ACTIVE,
        joinedAt: member.joinedAt,
      },
    ]);
    expect(Object.keys(result[0])).not.toContain('password');
  });
});

describe('OrganizationsService.updateMembership (1-7C)', () => {
  let service: OrganizationsService;
  let membershipModel: { findOne: jest.Mock };
  let socketRegistry: { disconnectMember: jest.Mock };
  let fixture: ReturnType<typeof makeSessionFixture17C>;

  async function build(actor: unknown, target: unknown) {
    fixture = makeSessionFixture17C();
    membershipModel = {
      findOne: jest.fn((filter: Record<string, unknown>) =>
        makeChain(filter._id ? target : actor),
      ),
    };
    socketRegistry = { disconnectMember: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsService,
        { provide: getModelToken(Organization.name), useValue: {} },
        {
          provide: getModelToken(OrganizationMembership.name),
          useValue: membershipModel,
        },
        { provide: getModelToken(OrganizationInvitation.name), useValue: {} },
        { provide: UsersService, useValue: {} },
        { provide: getConnectionToken(), useValue: fixture.connection },
        { provide: SocketRegistryService, useValue: socketRegistry },
        { provide: S3Service, useValue: s3ServiceStub },
      ],
    }).compile();
    service = module.get(OrganizationsService);
  }

  it('body vide → 400 EMPTY_MEMBERSHIP_UPDATE, aucune session ouverte', async () => {
    await build(null, null);
    const error = await service
      .updateMembership(ORG_ID_17C, ACTOR_USER_ID, TARGET_MEMBERSHIP_ID, {})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'EMPTY_MEMBERSHIP_UPDATE',
    });
  });

  it('cible étrangère/absente → 404, aucun disconnect', async () => {
    await build(membershipDoc(ACTOR_USER_ID, ACTOR_MEMBERSHIP_ID), null);
    const error = await service
      .updateMembership(ORG_ID_17C, ACTOR_USER_ID, TARGET_MEMBERSHIP_ID, {
        role: OrganizationRole.ADMIN,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect(socketRegistry.disconnectMember).not.toHaveBeenCalled();
  });

  it('self-management refusé (403 SELF_MANAGEMENT_FORBIDDEN)', async () => {
    const self = membershipDoc(ACTOR_USER_ID, TARGET_MEMBERSHIP_ID);
    await build(self, self);
    const error = await service
      .updateMembership(ORG_ID_17C, ACTOR_USER_ID, TARGET_MEMBERSHIP_ID, {
        status: MembershipStatus.SUSPENDED,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: 'SELF_MANAGEMENT_FORBIDDEN',
    });
    expect(socketRegistry.disconnectMember).not.toHaveBeenCalled();
  });

  it('modification de l’owner refusée (403 OWNER_NOT_MANAGEABLE), même par un autre owner', async () => {
    const actor = membershipDoc(ACTOR_USER_ID, ACTOR_MEMBERSHIP_ID, {
      role: OrganizationRole.OWNER,
    });
    const target = membershipDoc(TARGET_USER_ID, TARGET_MEMBERSHIP_ID, {
      role: OrganizationRole.OWNER,
    });
    await build(actor, target);
    const error = await service
      .updateMembership(ORG_ID_17C, ACTOR_USER_ID, TARGET_MEMBERSHIP_ID, {
        status: MembershipStatus.SUSPENDED,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: 'OWNER_NOT_MANAGEABLE',
    });
  });

  it('owner modifie librement rôle/permissions/statut d’un membre (aucune borne anti-escalade)', async () => {
    const actor = membershipDoc(ACTOR_USER_ID, ACTOR_MEMBERSHIP_ID, {
      role: OrganizationRole.OWNER,
    });
    const target = membershipDoc(TARGET_USER_ID, TARGET_MEMBERSHIP_ID, {
      role: OrganizationRole.SELLER,
      permissions: [],
    });
    await build(actor, target);

    const result = await service.updateMembership(
      ORG_ID_17C,
      ACTOR_USER_ID,
      TARGET_MEMBERSHIP_ID,
      { role: OrganizationRole.ADMIN, permissions: ['analytics.read'] },
    );

    expect(result.role).toBe(OrganizationRole.ADMIN);
    expect(result.permissions).toEqual(['analytics.read']);
    expect(target.save).toHaveBeenCalledWith({ session: fixture.session });
    // APRÈS le commit uniquement :
    expect(socketRegistry.disconnectMember).toHaveBeenCalledWith(
      ORG_ID_17C,
      TARGET_USER_ID,
    );
  });

  it('délégation members.manage SANS escalade : peut gérer un membre dont les permissions ⊆ les siennes', async () => {
    const actor = membershipDoc(ACTOR_USER_ID, ACTOR_MEMBERSHIP_ID, {
      role: OrganizationRole.SELLER,
      permissions: ['members.manage', 'analytics.read', 'sales.view_all'],
    });
    const target = membershipDoc(TARGET_USER_ID, TARGET_MEMBERSHIP_ID, {
      role: OrganizationRole.SELLER,
      permissions: ['analytics.read'],
    });
    await build(actor, target);

    const result = await service.updateMembership(
      ORG_ID_17C,
      ACTOR_USER_ID,
      TARGET_MEMBERSHIP_ID,
      { permissions: ['sales.view_all'] },
    );
    expect(result.permissions).toEqual(['sales.view_all']);
  });

  it('délégué members.manage : refuse d’attribuer PLUS de droits que les siens (403 PERMISSION_DENIED)', async () => {
    const actor = membershipDoc(ACTOR_USER_ID, ACTOR_MEMBERSHIP_ID, {
      role: OrganizationRole.SELLER,
      permissions: ['members.manage'],
    });
    const target = membershipDoc(TARGET_USER_ID, TARGET_MEMBERSHIP_ID, {
      role: OrganizationRole.SELLER,
      permissions: [],
    });
    await build(actor, target);

    const error = await service
      .updateMembership(ORG_ID_17C, ACTOR_USER_ID, TARGET_MEMBERSHIP_ID, {
        permissions: ['analytics.read'],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(target.save).not.toHaveBeenCalled();
  });

  it('délégué members.manage : refuse de gérer un membre ayant DÉJÀ plus de droits (403 PERMISSION_DENIED)', async () => {
    const actor = membershipDoc(ACTOR_USER_ID, ACTOR_MEMBERSHIP_ID, {
      role: OrganizationRole.SELLER,
      permissions: ['members.manage'],
    });
    const target = membershipDoc(TARGET_USER_ID, TARGET_MEMBERSHIP_ID, {
      role: OrganizationRole.ADMIN, // effective : toutes les permissions
      permissions: [],
    });
    await build(actor, target);

    const error = await service
      .updateMembership(ORG_ID_17C, ACTOR_USER_ID, TARGET_MEMBERSHIP_ID, {
        status: MembershipStatus.SUSPENDED,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('aucune réactivation implicite : `status` omis reste inchangé après un changement de rôle', async () => {
    const actor = membershipDoc(ACTOR_USER_ID, ACTOR_MEMBERSHIP_ID, {
      role: OrganizationRole.OWNER,
    });
    const target = membershipDoc(TARGET_USER_ID, TARGET_MEMBERSHIP_ID, {
      role: OrganizationRole.SELLER,
      status: MembershipStatus.SUSPENDED,
    });
    await build(actor, target);

    const result = await service.updateMembership(
      ORG_ID_17C,
      ACTOR_USER_ID,
      TARGET_MEMBERSHIP_ID,
      { role: OrganizationRole.ADMIN },
    );
    expect(result.status).toBe(MembershipStatus.SUSPENDED);
  });

  it('rollback (échec après relecture) : aucun disconnect, session toujours fermée', async () => {
    const actor = membershipDoc(ACTOR_USER_ID, ACTOR_MEMBERSHIP_ID, {
      role: OrganizationRole.OWNER,
    });
    const target = membershipDoc(TARGET_USER_ID, TARGET_MEMBERSHIP_ID);
    target.save = jest.fn().mockRejectedValue(new Error('save failed'));
    await build(actor, target);

    await expect(
      service.updateMembership(
        ORG_ID_17C,
        ACTOR_USER_ID,
        TARGET_MEMBERSHIP_ID,
        {
          role: OrganizationRole.ADMIN,
        },
      ),
    ).rejects.toThrow('save failed');
    expect(socketRegistry.disconnectMember).not.toHaveBeenCalled();
    expect(fixture.session.endSession).toHaveBeenCalledTimes(1);
  });
});

describe('OrganizationsService.transferOwnership (1-7C)', () => {
  let service: OrganizationsService;
  let membershipModel: { findOne: jest.Mock; countDocuments: jest.Mock };
  let socketRegistry: { disconnectMember: jest.Mock };
  let fixture: ReturnType<typeof makeSessionFixture17C>;

  async function build(actor: unknown, target: unknown, activeOwnersAfter = 1) {
    fixture = makeSessionFixture17C();
    membershipModel = {
      findOne: jest.fn((filter: Record<string, unknown>) =>
        makeChain(filter._id ? target : actor),
      ),
      countDocuments: jest.fn().mockResolvedValue(activeOwnersAfter),
    };
    socketRegistry = { disconnectMember: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsService,
        { provide: getModelToken(Organization.name), useValue: {} },
        {
          provide: getModelToken(OrganizationMembership.name),
          useValue: membershipModel,
        },
        { provide: getModelToken(OrganizationInvitation.name), useValue: {} },
        { provide: UsersService, useValue: {} },
        { provide: getConnectionToken(), useValue: fixture.connection },
        { provide: SocketRegistryService, useValue: socketRegistry },
        { provide: S3Service, useValue: s3ServiceStub },
      ],
    }).compile();
    service = module.get(OrganizationsService);
  }

  const owner = () =>
    membershipDoc(ACTOR_USER_ID, ACTOR_MEMBERSHIP_ID, {
      role: OrganizationRole.OWNER,
    });

  it('transfert atomique : ancien owner → admin/active, cible → owner/active', async () => {
    const actor = owner();
    const target = membershipDoc(TARGET_USER_ID, TARGET_MEMBERSHIP_ID, {
      role: OrganizationRole.SELLER,
    });
    await build(actor, target);

    const result = await service.transferOwnership(
      ORG_ID_17C,
      ACTOR_USER_ID,
      TARGET_MEMBERSHIP_ID,
    );

    expect(result.previousOwner.role).toBe(OrganizationRole.ADMIN);
    expect(result.previousOwner.status).toBe(MembershipStatus.ACTIVE);
    expect(result.newOwner.role).toBe(OrganizationRole.OWNER);
    expect(result.newOwner.status).toBe(MembershipStatus.ACTIVE);
    expect(actor.save).toHaveBeenCalledWith({ session: fixture.session });
    expect(target.save).toHaveBeenCalledWith({ session: fixture.session });
    // APRÈS le commit uniquement : ancien ET nouveau owner déconnectés.
    expect(socketRegistry.disconnectMember).toHaveBeenCalledWith(
      ORG_ID_17C,
      ACTOR_USER_ID,
    );
    expect(socketRegistry.disconnectMember).toHaveBeenCalledWith(
      ORG_ID_17C,
      TARGET_USER_ID,
    );
  });

  it('cible = propriétaire actuel → 409 TRANSFER_TARGET_IS_CURRENT_OWNER', async () => {
    const actor = owner();
    const sameAsActor = membershipDoc(ACTOR_USER_ID, TARGET_MEMBERSHIP_ID, {
      role: OrganizationRole.OWNER,
    });
    await build(actor, sameAsActor);

    const error = await service
      .transferOwnership(ORG_ID_17C, ACTOR_USER_ID, TARGET_MEMBERSHIP_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'TRANSFER_TARGET_IS_CURRENT_OWNER',
    });
  });

  it('cible inactive → 409 TRANSFER_TARGET_NOT_ACTIVE', async () => {
    const actor = owner();
    const target = membershipDoc(TARGET_USER_ID, TARGET_MEMBERSHIP_ID, {
      status: MembershipStatus.SUSPENDED,
    });
    await build(actor, target);

    const error = await service
      .transferOwnership(ORG_ID_17C, ACTOR_USER_ID, TARGET_MEMBERSHIP_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'TRANSFER_TARGET_NOT_ACTIVE',
    });
  });

  it('cible étrangère/absente → 404', async () => {
    const actor = owner();
    await build(actor, null);

    const error = await service
      .transferOwnership(ORG_ID_17C, ACTOR_USER_ID, TARGET_MEMBERSHIP_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
  });

  it('invariant « exactement un owner actif » violé avant commit → transaction annulée, aucun disconnect', async () => {
    const actor = owner();
    const target = membershipDoc(TARGET_USER_ID, TARGET_MEMBERSHIP_ID);
    await build(actor, target, 2); // countDocuments renvoie 2 : invariant violé

    await expect(
      service.transferOwnership(
        ORG_ID_17C,
        ACTOR_USER_ID,
        TARGET_MEMBERSHIP_ID,
      ),
    ).rejects.toThrow(/exactly one active owner/);
    expect(socketRegistry.disconnectMember).not.toHaveBeenCalled();
    expect(fixture.session.endSession).toHaveBeenCalledTimes(1);
  });

  it('acteur non-owner (rôle STRICT, jamais via permissions injectées) → refus accès', async () => {
    const fakeOwnerPermission = membershipDoc(
      ACTOR_USER_ID,
      ACTOR_MEMBERSHIP_ID,
      {
        role: OrganizationRole.ADMIN,
        permissions: ['ownership.transfer' as unknown as DelegablePermission],
      },
    );
    const target = membershipDoc(TARGET_USER_ID, TARGET_MEMBERSHIP_ID);
    await build(fakeOwnerPermission, target);

    const error = await service
      .transferOwnership(ORG_ID_17C, ACTOR_USER_ID, TARGET_MEMBERSHIP_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: ACCESS_DENIED_CODE,
    });
  });
});

// =============================================================================
// Branding (1-8A) — getCurrent / updateBranding / removeLogo
// =============================================================================
describe('OrganizationsService — branding (1-8A)', () => {
  const ORG_ID_18A = '778899001122334455667788';

  let service: OrganizationsService;
  let organizationModel: { findOne: jest.Mock };
  let s3Service: { publicUrlForKey: jest.Mock };

  function orgDoc(overrides: Record<string, unknown> = {}) {
    const doc = {
      _id: new Types.ObjectId(ORG_ID_18A),
      name: 'Org 18A',
      slug: 'org-18a',
      brandColor: '#FF6A00',
      currency: 'XAF',
      status: OrganizationStatus.ACTIVE,
      logoKey: null as string | null,
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    return doc;
  }

  async function build(organization: unknown) {
    organizationModel = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(organization) })),
    };
    s3Service = {
      publicUrlForKey: jest.fn((key: string) => `http://s3/${key}`),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsService,
        {
          provide: getModelToken(Organization.name),
          useValue: organizationModel,
        },
        { provide: getModelToken(OrganizationMembership.name), useValue: {} },
        { provide: getModelToken(OrganizationInvitation.name), useValue: {} },
        { provide: UsersService, useValue: {} },
        { provide: getConnectionToken(), useValue: {} },
        {
          provide: SocketRegistryService,
          useValue: { disconnectMember: jest.fn() },
        },
        { provide: S3Service, useValue: s3Service },
      ],
    }).compile();
    service = module.get(OrganizationsService);
  }

  describe('getCurrent', () => {
    it('vue minimale, logoUrl null sans logoKey', async () => {
      await build(orgDoc());
      const view = await service.getCurrent(ORG_ID_18A);
      expect(view).toEqual({
        _id: ORG_ID_18A,
        name: 'Org 18A',
        slug: 'org-18a',
        brandColor: '#FF6A00',
        currency: 'XAF',
        status: OrganizationStatus.ACTIVE,
        logoUrl: null,
      });
      expect(organizationModel.findOne).toHaveBeenCalledWith({
        _id: new Types.ObjectId(ORG_ID_18A),
      });
    });

    it('logoUrl dérivée de logoKey via S3Service.publicUrlForKey, jamais logoKey exposée', async () => {
      await build(
        orgDoc({ logoKey: `organizations/${ORG_ID_18A}/branding/abc.png` }),
      );
      const view = await service.getCurrent(ORG_ID_18A);
      expect(view.logoUrl).toBe(
        `http://s3/organizations/${ORG_ID_18A}/branding/abc.png`,
      );
      expect(Object.keys(view)).not.toContain('logoKey');
    });

    it('organisation absente → refus uniforme (défensif)', async () => {
      await build(null);
      const error = await service
        .getCurrent(ORG_ID_18A)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: ACCESS_DENIED_CODE,
      });
    });
  });

  describe('updateBranding', () => {
    it('body vide (aucun champ, aucun logo) → 400 EMPTY_BRANDING_UPDATE', async () => {
      await build(orgDoc());
      const error = await service
        .updateBranding(ORG_ID_18A, {})
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'EMPTY_BRANDING_UPDATE',
      });
    });

    it('name vide après trim → 400 INVALID_BRANDING_NAME, aucune sauvegarde', async () => {
      const doc = orgDoc();
      await build(doc);
      const error = await service
        .updateBranding(ORG_ID_18A, { name: '   ' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'INVALID_BRANDING_NAME',
      });
      expect(doc.save).not.toHaveBeenCalled();
    });

    it('name/brandColor : champs mis à jour explicitement, name trimmé, aucun appel S3 (pas de nouveau logo)', async () => {
      const doc = orgDoc({ name: 'Ancien nom' });
      await build(doc);
      const result = await service.updateBranding(ORG_ID_18A, {
        name: '  Nouveau nom  ',
        brandColor: '#062B5C',
      });
      expect(doc.name).toBe('Nouveau nom');
      expect(doc.brandColor).toBe('#062B5C');
      expect(doc.save).toHaveBeenCalledTimes(1);
      expect(result.previousLogoKey).toBeNull();
    });

    it('nouveau logo fourni : logoKey appliqué, ancien logoKey retourné pour nettoyage APRÈS ce commit', async () => {
      const doc = orgDoc({
        logoKey: `organizations/${ORG_ID_18A}/branding/old.png`,
      });
      await build(doc);
      const newKey = `organizations/${ORG_ID_18A}/branding/new.png`;
      const result = await service.updateBranding(ORG_ID_18A, {}, newKey);
      expect(doc.logoKey).toBe(newKey);
      expect(result.previousLogoKey).toBe(
        `organizations/${ORG_ID_18A}/branding/old.png`,
      );
    });

    it('nouveau logo fourni sans logo préexistant : previousLogoKey null (rien à nettoyer)', async () => {
      await build(orgDoc());
      const newKey = `organizations/${ORG_ID_18A}/branding/new.png`;
      const result = await service.updateBranding(ORG_ID_18A, {}, newKey);
      expect(result.previousLogoKey).toBeNull();
    });

    it('organisation absente → refus uniforme, aucune sauvegarde tentée', async () => {
      await build(null);
      const error = await service
        .updateBranding(ORG_ID_18A, { name: 'X' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
    });
  });

  describe('removeLogo', () => {
    it('logoKey → null, ancien logoKey retourné', async () => {
      const doc = orgDoc({
        logoKey: `organizations/${ORG_ID_18A}/branding/old.png`,
      });
      await build(doc);
      const result = await service.removeLogo(ORG_ID_18A);
      expect(doc.logoKey).toBeNull();
      expect(doc.save).toHaveBeenCalledTimes(1);
      expect(result.previousLogoKey).toBe(
        `organizations/${ORG_ID_18A}/branding/old.png`,
      );
      expect(result.organization.logoUrl).toBeNull();
    });

    it('déjà sans logo : no-op DB (aucune sauvegarde), previousLogoKey null', async () => {
      const doc = orgDoc();
      await build(doc);
      const result = await service.removeLogo(ORG_ID_18A);
      expect(doc.save).not.toHaveBeenCalled();
      expect(result.previousLogoKey).toBeNull();
    });

    it('organisation absente → refus uniforme', async () => {
      await build(null);
      const error = await service
        .removeLogo(ORG_ID_18A)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
    });
  });
});
