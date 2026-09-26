import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController, isPublicRegistrationEnabled } from './auth.controller';
import { AuthService } from './auth.service';
import { OrganizationsService } from '../organizations/organizations.service';
import {
  ALL_DELEGABLE_PERMISSIONS,
  DelegablePermission,
  OrganizationRole,
} from '../organizations/permissions';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  AuthThrottlerGuard,
  createAuthThrottlerOptions,
} from '../common/auth-rate-limiting';

/**
 * AuthController — garde de l'inscription publique (0B.5) +
 * choix d'organisation au login + switch d'organisation.
 */
describe('AuthController', () => {
  let controller: AuthController;
  let registerMock: jest.Mock;
  let loginMock: jest.Mock;
  let switchMock: jest.Mock;
  let acceptInvitationMock: jest.Mock;
  let listActiveOrganizationsMock: jest.Mock;

  const VALID_REG: RegisterDto = {
    name: 'E2E User',
    email: 'e2e-register@royalvibe.test',
    password: 'secret-123',
    organizationName: 'E2E Org',
  };
  const VALID_LOGIN: LoginDto = {
    email: 'seller@royalvibe.test',
    password: 'secret-123',
  };
  const AUTH_USER = { _id: '112233445566778899001122' } as unknown;

  function callRegister(): unknown {
    try {
      return controller.register(VALID_REG);
    } catch (e) {
      return e;
    }
  }

  afterEach(() => {
    delete process.env.PUBLIC_REGISTRATION_ENABLED;
  });

  beforeEach(async () => {
    registerMock = jest.fn();
    loginMock = jest.fn();
    switchMock = jest.fn();
    acceptInvitationMock = jest.fn();
    listActiveOrganizationsMock = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      // Garde 0B.6 : enregistrée pour que la DI du contrôleur se résolve
      // (controller.login() est appelé DIRECTEMENT — la limite ne se
      // déclenche jamais ici, détermine).
      imports: [ThrottlerModule.forRoot(createAuthThrottlerOptions())],
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            register: registerMock,
            login: loginMock,
            switchOrganization: switchMock,
          },
        },
        {
          provide: OrganizationsService,
          useValue: {
            acceptInvitation: acceptInvitationMock,
            listActiveOrganizations: listActiveOrganizationsMock,
          },
        },
        AuthThrottlerGuard,
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  // ---- garde d'inscription publique (inchangée) ----

  it('isPublicRegistrationEnabled : vraie seulement pour la valeur exacte "true"', () => {
    expect(isPublicRegistrationEnabled()).toBe(false);
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
    expect(isPublicRegistrationEnabled()).toBe(true);
    process.env.PUBLIC_REGISTRATION_ENABLED = 'TRUE';
    expect(isPublicRegistrationEnabled()).toBe(false);
  });

  it.each([
    ['absente', undefined],
    ['"false"', 'false'],
    ['"1"', '1'],
    ['"yes"', 'yes'],
    ['"TRUE" (sensible à la casse)', 'TRUE'],
    ['"true " (espace)', 'true '],
    ['"" (chaîne vide)', ''],
  ])(
    'inscription désactivée (%s) → 403 REGISTRATION_DISABLED, service jamais appelé',
    (_label, value) => {
      if (value === undefined) {
        delete process.env.PUBLIC_REGISTRATION_ENABLED;
      } else {
        process.env.PUBLIC_REGISTRATION_ENABLED = value;
      }

      const error = callRegister();
      expect(error).toBeInstanceOf(ForbiddenException);
      const exc = error as ForbiddenException;
      expect(exc.getStatus()).toBe(403);
      expect((exc.getResponse() as { code: string }).code).toBe(
        'REGISTRATION_DISABLED',
      );
      expect(registerMock).not.toHaveBeenCalled();
    },
  );

  it('inscription activée → AuthService.register appelé avec le DTO', async () => {
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
    const result = { user: { email: 'a@b.c' } };
    registerMock.mockResolvedValue(result);
    const out = await controller.register(VALID_REG);
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(registerMock).toHaveBeenCalledWith(VALID_REG);
    expect(out).toEqual(result);
  });

  // ---- login : forwarding de l'organisation ----

  it('login sans organisation → le service reçoit le DTO sans organizationId', async () => {
    loginMock.mockResolvedValue({ access_token: 'ok' });
    await controller.login(VALID_LOGIN);
    expect(loginMock).toHaveBeenCalledTimes(1);
    expect(loginMock).toHaveBeenCalledWith(VALID_LOGIN);
    expect(VALID_LOGIN).not.toHaveProperty('organizationId');
  });

  it('login avec organizationId → le champ est transmis au service inchangé', async () => {
    const ORG_ID = '223344556677889900112233';
    loginMock.mockResolvedValue({ access_token: 'ok' });
    const dto: LoginDto = { ...VALID_LOGIN, organizationId: ORG_ID };
    await controller.login(dto);
    expect(loginMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID }),
    );
  });

  // ---- switch d'organisation ----

  it('switch : le service reçoit le sub de l’utilisateur authentifié (jamais du body)', async () => {
    switchMock.mockResolvedValue({ access_token: 'ok' });
    const dto = { organizationId: '334455667788990011223344' };
    const out = await controller.switchOrganization(AUTH_USER, dto);
    expect(switchMock).toHaveBeenCalledTimes(1);
    expect(switchMock).toHaveBeenCalledWith(AUTH_USER._id, {
      organizationId: dto.organizationId,
    });
    // aucun champ utilisateur du body n'est transmis :
    expect(switchMock.mock.calls[0][1]).toEqual({
      organizationId: dto.organizationId,
    });
    expect(out).toEqual({ access_token: 'ok' });
  });

  it('switch : aucune dérive du body (userId écarté) — le service ne reçoit que l’organizationId ciblée', async () => {
    switchMock.mockResolvedValue({ access_token: 'ok' });
    // Le DTO (forbidNonWhitelisted + whitelist) rejette un userId avant que
    // le contrôleur ne voie le body : le sub ne peut provenir QUE du JWT.
    // Ici on vérifie que le contrôleur ne transmet QUE `organizationId` :
    const dto = { organizationId: '112233445566778899001122' };
    await controller.switchOrganization(AUTH_USER, dto);
    expect(switchMock).toHaveBeenCalledWith(AUTH_USER._id, {
      organizationId: dto.organizationId,
    });
  });

  // ---- acceptation d'invitation (1-6B.2) ----

  it('acceptInvitation : délègue à OrganizationsService.acceptInvitation avec le DTO exact', async () => {
    const result = {
      user: { _id: '1', name: 'A', email: 'a@b.co' },
      organization: { _id: '2', name: 'Org', slug: 'org' },
      membership: { role: 'seller', status: 'active' },
    };
    acceptInvitationMock.mockResolvedValue(result);
    const dto = { token: 'raw-token', name: 'Ada', password: 'secret-123' };
    const out = await controller.acceptInvitation(dto);
    expect(acceptInvitationMock).toHaveBeenCalledTimes(1);
    expect(acceptInvitationMock).toHaveBeenCalledWith(dto);
    expect(out).toEqual(result);
  });

  // ---- organisations actives (1-9B) ----

  it('organizations : délègue à listActiveOrganizations avec le sub du JWT, aucun autre paramètre', async () => {
    const list = [{ organizationId: 'a', name: 'Org A' }];
    listActiveOrganizationsMock.mockResolvedValue(list);
    const out = await controller.organizations(AUTH_USER);
    expect(listActiveOrganizationsMock).toHaveBeenCalledTimes(1);
    expect(listActiveOrganizationsMock).toHaveBeenCalledWith(AUTH_USER._id);
    expect(out).toEqual(list);
  });

  // ---- contexte d'autorisation (1-9C) ----

  it('context : renvoie exclusivement les champs de request.organizationContext (jamais un lookup)', () => {
    const organizationContext = {
      userId: '111111111111111111111111',
      organizationId: '222222222222222222222222',
      membershipId: '333333333333333333333333',
      role: OrganizationRole.SELLER,
      permissions: ['analytics.read'] as DelegablePermission[],
    };
    const out = controller.context(organizationContext);
    expect(out).toEqual({
      userId: organizationContext.userId,
      organizationId: organizationContext.organizationId,
      role: OrganizationRole.SELLER,
      permissions: ['analytics.read'],
      // seller par défaut : sales.record + sales.view_own, ∪ analytics.read accordé.
      effectivePermissions: expect.arrayContaining([
        'sales.record',
        'sales.view_own',
        'analytics.read',
      ]),
    });
    expect(out.effectivePermissions).toHaveLength(3);
    // jamais membershipId (donnée interne, hors contrat de réponse) :
    expect(out).not.toHaveProperty('membershipId');
  });

  it('context : owner sans permission supplémentaire → effectivePermissions couvre déjà tout le délégable', () => {
    const organizationContext = {
      userId: '111111111111111111111111',
      organizationId: '222222222222222222222222',
      membershipId: '333333333333333333333333',
      role: OrganizationRole.OWNER,
      permissions: [] as DelegablePermission[],
    };
    const out = controller.context(organizationContext);
    expect(out.effectivePermissions).toEqual(
      expect.arrayContaining(ALL_DELEGABLE_PERMISSIONS as unknown as string[]),
    );
    expect(out.effectivePermissions).toHaveLength(
      ALL_DELEGABLE_PERMISSIONS.length,
    );
  });
});
