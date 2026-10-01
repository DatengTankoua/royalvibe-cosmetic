import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import {
  ORGANIZATION_ACCESS_DENIED,
  OrganizationsService,
} from '../organizations/organizations.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { AccessScope } from '../subscriptions/subscription-access';
import { EmailVerificationService } from '../email-verification/email-verification.service';

const USER_OBJECT_ID = '112233445566778899001122';
const ORG_A_ID = '223344556677889900112233';
const ORG_B_ID = '334455667788990011223344';

/** Normalise le corps d'erreur (string ou objet Nest 11). */
function extractMessage(error: unknown): string {
  const body = (error as { getResponse?: () => unknown })?.getResponse();
  if (typeof body === 'string') return body;
  if (body !== null && typeof body === 'object' && 'message' in body) {
    return String((body as Record<string, unknown>)['message']);
  }
  return String(body);
}

function makeUserDoc(overrides: Record<string, unknown> = {}): unknown {
  const doc = {
    _id: USER_OBJECT_ID,
    name: 'Ada',
    email: 'ada@example.com',
    password: '$2a$10$x7VQm9LbRdHhGk2sP0v1OeuJ5tYzWAbCdEfGhIjKlMnOpQrStUvWx',
    role: 'seller',
    // 1-13A : fixtures de login vérifiées explicitement.
    emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
  return { ...doc, toObject: () => ({ ...doc }) };
}

/**
 * Session transactionnelle mockée (1-6A) : même motif que
 * `sales.service.spec.ts` — une référence STABLE et UNIQUE renvoyée par
 * `startSession()`, comparée par `toBe` pour prouver que la MÊME session est
 * transmise à `UsersService.create` et à
 * `OrganizationsService.createOwnerOrganization`. `withTransaction` EXÉCUTE
 * le callback (comme le driver réel) et propage tout rejet.
 */
function makeConnectionFixture() {
  const endSession = jest.fn().mockResolvedValue(true);
  const withTransaction = jest.fn(
    async (cb: (s: unknown) => Promise<unknown>) => cb(sessionRef),
  );
  const sessionRef = { withTransaction, endSession };
  const connection = {
    startSession: jest.fn(() => Promise.resolve(sessionRef)),
  };
  return { withTransaction, endSession, session: sessionRef, connection };
}

describe('AuthService', () => {
  let service: AuthService;
  let usersService: {
    findByEmail: jest.Mock;
    create: jest.Mock;
    findByIdForAuth: jest.Mock;
  };
  let jwt: { sign: jest.Mock };
  let organizations: {
    resolveActiveContext: jest.Mock;
    listActiveOrganizations: jest.Mock;
    createOwnerOrganization: jest.Mock;
  };
  let connectionFixture: ReturnType<typeof makeConnectionFixture>;
  let emailVerification: { issueForUser: jest.Mock };
  // 1-14C.1 : contrôle commercial (actif par défaut ; cas inactifs dédiés).
  let subscriptions: { getAccessDecision: jest.Mock };

  async function build() {
    usersService = {
      findByEmail: jest.fn(),
      create: jest.fn(),
      findByIdForAuth: jest.fn(),
    };
    jwt = { sign: jest.fn().mockReturnValue('signed-token') };
    organizations = {
      // 1-14C.1 : le login à organisation unique résout aussi le contexte
      // (rôle réel) — défaut : membership active pour l'organisation demandée.
      resolveActiveContext: jest.fn((userId: string, organizationId: string) =>
        Promise.resolve({
          userId,
          organizationId,
          membershipId: '99',
          role: 'owner',
          permissions: [],
        }),
      ),
      listActiveOrganizations: jest.fn(),
      createOwnerOrganization: jest.fn(),
    };
    connectionFixture = makeConnectionFixture();
    emailVerification = { issueForUser: jest.fn().mockResolvedValue('sent') };
    subscriptions = {
      getAccessDecision: jest.fn().mockResolvedValue({
        state: 'active',
        active: true,
        coverageEndsAt: new Date('2099-01-01T00:00:00.000Z'),
        checkedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwt },
        { provide: OrganizationsService, useValue: organizations },
        {
          provide: getConnectionToken(),
          useValue: connectionFixture.connection,
        },
        { provide: EmailVerificationService, useValue: emailVerification },
        { provide: SubscriptionsService, useValue: subscriptions },
      ],
    }).compile();
    return module.get(AuthService);
  }

  const hashRight = async () => bcrypt.hash('right-password-1', 10);

  // ---- register : onboarding atomique propriétaire (1-6A) ----

  describe('register — onboarding atomique propriétaire (1-6A)', () => {
    const VALID_DTO = {
      name: 'Ada',
      email: 'ada@example.com',
      password: 'secret1',
      organizationName: 'Ada Corp',
    };

    function makeCreatedUser(overrides: Record<string, unknown> = {}) {
      return {
        _id: { toString: () => USER_OBJECT_ID },
        name: 'Ada',
        email: 'ada@example.com',
        password: 'hashed-value',
        role: 'admin',
        ...overrides,
      };
    }

    function makeCreatedOrganization(overrides: Record<string, unknown> = {}) {
      return {
        _id: { toString: () => ORG_A_ID },
        name: 'Ada Corp',
        slug: 'ada-corp-a1b2c3d4',
        currency: 'XAF',
        status: 'active',
        ...overrides,
      };
    }

    function mockHappyPath() {
      usersService.create.mockResolvedValue(makeCreatedUser());
      organizations.createOwnerOrganization.mockResolvedValue({
        organization: makeCreatedOrganization(),
        membership: { _id: 'membership-id' },
      });
    }

    it('hache le mot de passe (jamais le texte en clair) avant de créer le User', async () => {
      service = await build();
      mockHappyPath();
      await service.register(VALID_DTO);
      const created = usersService.create.mock.calls[0][0] as {
        password: string;
      };
      expect(created.password).not.toBe('secret1');
      await expect(bcrypt.compare('secret1', created.password)).resolves.toBe(
        true,
      );
    });

    it('crée le User avec le rôle legacy admin (jamais exposé dans la réponse)', async () => {
      service = await build();
      mockHappyPath();
      const result = await service.register(VALID_DTO);
      expect(usersService.create.mock.calls[0][0]).toMatchObject({
        role: 'admin',
      });
      expect(JSON.stringify(result)).not.toContain('admin');
      expect('role' in result.user).toBe(false);
    });

    it('startSession()/endSession() : session ouverte puis TOUJOURS fermée', async () => {
      service = await build();
      mockHappyPath();
      await service.register(VALID_DTO);
      expect(connectionFixture.connection.startSession).toHaveBeenCalledTimes(
        1,
      );
      expect(connectionFixture.withTransaction).toHaveBeenCalledTimes(1);
      expect(connectionFixture.endSession).toHaveBeenCalledTimes(1);
    });

    it('MÊME session transmise à UsersService.create ET OrganizationsService.createOwnerOrganization', async () => {
      service = await build();
      mockHappyPath();
      await service.register(VALID_DTO);
      const userSession = usersService.create.mock.calls[0][1] as unknown;
      const orgSession = organizations.createOwnerOrganization.mock
        .calls[0][2] as unknown;
      expect(userSession).toBe(connectionFixture.session);
      expect(orgSession).toBe(connectionFixture.session);
    });

    it("l'organisation reçoit le nom du DTO et l'id du User créé (jamais un id client)", async () => {
      service = await build();
      mockHappyPath();
      await service.register(VALID_DTO);
      expect(organizations.createOwnerOrganization).toHaveBeenCalledWith(
        'Ada Corp',
        USER_OBJECT_ID,
        connectionFixture.session,
      );
    });

    it('réponse exacte : user{_id,name,email} + organization{_id,name,slug,currency,status} + emailVerification — rien de plus', async () => {
      service = await build();
      mockHappyPath();
      const result = await service.register(VALID_DTO);
      expect(Object.keys(result).sort()).toEqual([
        'emailVerification',
        'organization',
        'user',
      ]);
      expect(result.emailVerification).toEqual({ status: 'sent' });
      expect(Object.keys(result.user).sort()).toEqual(['_id', 'email', 'name']);
      expect(Object.keys(result.organization).sort()).toEqual([
        '_id',
        'currency',
        'name',
        'slug',
        'status',
      ]);
      const flat = JSON.stringify(result);
      expect(flat).not.toContain('password');
      expect(flat).not.toContain('access_token');
      expect(flat).not.toContain('membershipId');
      expect(flat).not.toContain('permissions');
      expect(jwt.sign).not.toHaveBeenCalled();
    });

    it('email dupliqué (E11000) → conflit stable existant, Organization JAMAIS créée', async () => {
      service = await build();
      const duplicateError = Object.assign(new Error('E11000 duplicate key'), {
        code: 11000,
      });
      usersService.create.mockRejectedValue(duplicateError);
      await expect(service.register(VALID_DTO)).rejects.toThrow(
        BadRequestException,
      );
      expect(organizations.createOwnerOrganization).not.toHaveBeenCalled();
      expect(connectionFixture.endSession).toHaveBeenCalledTimes(1);
    });

    it("échec de création de l'Organization → rollback (session fermée, propagation de l'erreur d'origine)", async () => {
      service = await build();
      usersService.create.mockResolvedValue(makeCreatedUser());
      organizations.createOwnerOrganization.mockRejectedValue(
        new Error('organization creation failed'),
      );
      await expect(service.register(VALID_DTO)).rejects.toThrow(
        'organization creation failed',
      );
      expect(connectionFixture.endSession).toHaveBeenCalledTimes(1);
    });
  });

  // ---- login : refus identifiants (inchangés) ----

  describe('register / invitation — vérification email après commit (1-13A)', () => {
    const VALID_DTO = {
      name: 'Ada',
      email: 'ada@example.com',
      password: 'secret1',
      organizationName: 'Ada Corp',
    };

    function mockCreation() {
      usersService.create.mockResolvedValue({
        _id: { toString: () => USER_OBJECT_ID },
        name: 'Ada',
        email: 'ada@example.com',
      });
      organizations.createOwnerOrganization.mockResolvedValue({
        organization: {
          _id: { toString: () => ORG_A_ID },
          name: 'Ada Corp',
          slug: 'ada-corp',
          currency: 'XAF',
          status: 'active',
        },
      });
    }

    it('envoi APRÈS le commit (session fermée) pour le User créé', async () => {
      service = await build();
      mockCreation();
      let sessionEndedBeforeSend = false;
      emailVerification.issueForUser.mockImplementation(() => {
        sessionEndedBeforeSend =
          connectionFixture.endSession.mock.calls.length === 1;
        return Promise.resolve('sent');
      });
      await service.register(VALID_DTO);
      expect(sessionEndedBeforeSend).toBe(true);
      expect(emailVerification.issueForUser).toHaveBeenCalledTimes(1);
      expect(emailVerification.issueForUser).toHaveBeenCalledWith(
        USER_OBJECT_ID,
      );
    });

    it('échec d’envoi → compte créé, statut `failed`, aucune exception', async () => {
      service = await build();
      mockCreation();
      emailVerification.issueForUser.mockResolvedValue('failed');
      const result = await service.register(VALID_DTO);
      expect(result.user._id).toBe(USER_OBJECT_ID);
      expect(result.emailVerification).toEqual({ status: 'failed' });
    });

    it('transaction en échec → aucun envoi', async () => {
      service = await build();
      usersService.create.mockRejectedValue(new Error('boom'));
      await expect(service.register(VALID_DTO)).rejects.toThrow('boom');
      expect(emailVerification.issueForUser).not.toHaveBeenCalled();
    });

    it('acceptInvitation : acceptation déléguée puis envoi pour le User rattaché', async () => {
      const acceptInvitation = jest.fn().mockResolvedValue({
        user: { _id: USER_OBJECT_ID, name: 'Ada', email: 'ada@example.com' },
        organization: { _id: ORG_A_ID, name: 'Ada Corp', slug: 'ada-corp' },
        membership: { role: 'seller', status: 'active' },
      });
      service = await build();
      (organizations as unknown as Record<string, jest.Mock>).acceptInvitation =
        acceptInvitation;
      emailVerification.issueForUser.mockResolvedValue('not_required');
      const dto = { token: 'tok' };
      const result = await service.acceptInvitation(dto);
      expect(acceptInvitation).toHaveBeenCalledWith(dto);
      expect(emailVerification.issueForUser).toHaveBeenCalledWith(
        USER_OBJECT_ID,
      );
      expect(result.emailVerification).toEqual({ status: 'not_required' });
      expect(result.membership).toEqual({ role: 'seller', status: 'active' });
    });

    it('acceptInvitation refusée → aucun envoi', async () => {
      service = await build();
      (organizations as unknown as Record<string, jest.Mock>).acceptInvitation =
        jest.fn().mockRejectedValue(new BadRequestException());
      await expect(service.acceptInvitation({ token: 'x' })).rejects.toThrow(
        BadRequestException,
      );
      expect(emailVerification.issueForUser).not.toHaveBeenCalled();
    });
  });

  describe('login — adresse non vérifiée (1-13A)', () => {
    it.each([
      ['absent', undefined],
      ['null', null],
    ])(
      'emailVerifiedAt %s + bons identifiants → 403 EMAIL_NOT_VERIFIED, aucun JWT ni requête organisationnelle',
      async (_label, value) => {
        service = await build();
        usersService.findByEmail.mockResolvedValue(
          makeUserDoc({ password: await hashRight(), emailVerifiedAt: value }),
        );
        const error: unknown = await service
          .login({ email: 'ada@example.com', password: 'right-password-1' })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: 'EMAIL_NOT_VERIFIED',
        });
        expect(organizations.listActiveOrganizations).not.toHaveBeenCalled();
        expect(organizations.resolveActiveContext).not.toHaveBeenCalled();
        expect(jwt.sign).not.toHaveBeenCalled();
      },
    );

    it('non vérifié + mauvais mot de passe → 401 générique (identifiants vérifiés d’abord)', async () => {
      service = await build();
      usersService.findByEmail.mockResolvedValue(
        makeUserDoc({ password: await hashRight(), emailVerifiedAt: null }),
      );
      const error: unknown = await service
        .login({ email: 'ada@example.com', password: 'wrong-password-1' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(
        JSON.stringify((error as UnauthorizedException).getResponse()),
      ).not.toContain('EMAIL_NOT_VERIFIED');
    });
  });

  describe('login (refus identifiants, inchangé)', () => {
    it('email inconnu → 401 message générique ; aucune requête organisationnelle', async () => {
      service = await build();
      usersService.findByEmail.mockResolvedValue(null);
      const error: unknown = await service
        .login({ email: 'missing@example.com', password: 'secret1' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(extractMessage(error)).toBe('Email ou mot de passe incorrect!');
      expect(organizations.listActiveOrganizations).not.toHaveBeenCalled();
      expect(jwt.sign).not.toHaveBeenCalled();
    });

    it('mot de passe incorrect → 401 même message ; aucune requête organisationnelle', async () => {
      service = await build();
      usersService.findByEmail.mockResolvedValue(
        makeUserDoc({ password: await hashRight() }),
      );
      const error: unknown = await service
        .login({ email: 'ada@example.com', password: 'wrong-password-1' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(extractMessage(error)).toBe('Email ou mot de passe incorrect!');
      expect(organizations.listActiveOrganizations).not.toHaveBeenCalled();
    });
  });

  // ---- login : cas organisationnels ----

  describe('login (règles d’organisation A–D)', () => {
    const validLogin = {
      email: 'ada@example.com',
      password: 'right-password-1',
    };

    it('A. zéro organisation active → 403 ORGANIZATION_ACCESS_DENIED, aucun JWT', async () => {
      service = await build();
      usersService.findByEmail.mockResolvedValue(
        makeUserDoc({ password: await hashRight() }),
      );
      organizations.listActiveOrganizations.mockResolvedValue([]);

      const error: unknown = await service
        .login(validLogin)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      const exc = error as ForbiddenException;
      expect(exc.getStatus()).toBe(403);
      const response = exc.getResponse() as { code: string; message: string };
      expect(response.code).toBe(ORGANIZATION_ACCESS_DENIED);
      expect(jwt.sign).not.toHaveBeenCalled();
    });

    it('B. une seule organisation → JWT automatique pour cette organisation', async () => {
      service = await build();
      usersService.findByEmail.mockResolvedValue(
        makeUserDoc({ password: await hashRight() }),
      );
      organizations.listActiveOrganizations.mockResolvedValue([
        { organizationId: ORG_A_ID, name: 'Org A' },
      ]);

      const { access_token, user } = await service.login(validLogin);

      expect(access_token).toBe('signed-token');
      expect(jwt.sign).toHaveBeenCalledTimes(1);
      expect(jwt.sign).toHaveBeenCalledWith({
        sub: USER_OBJECT_ID,
        orgId: ORG_A_ID,
        ver: 0,
        accessScope: 'app',
      });
      expect(user.email).toBe('ada@example.com');
      expect(user.password).toBeUndefined();
    });

    it('C. plusieurs organisations, aucun choix → organisationSelectionRequired sans JWT', async () => {
      service = await build();
      usersService.findByEmail.mockResolvedValue(
        makeUserDoc({ password: await hashRight() }),
      );
      organizations.listActiveOrganizations.mockResolvedValue([
        { organizationId: ORG_A_ID, name: 'Org A' },
        { organizationId: ORG_B_ID, name: 'Org B' },
      ]);

      const result = (await service.login(validLogin)) as {
        organizationSelectionRequired: boolean;
        organizations: unknown[];
      };

      expect(result.organizationSelectionRequired).toBe(true);
      expect(jwt.sign).not.toHaveBeenCalled();
      expect('access_token' in result).toBe(false);
      // liste minimale : uniquement { organizationId, name } — ni permissions,
      // ni membershipId, aucune clé supplémentaire.
      expect(result.organizations).toEqual([
        { organizationId: ORG_A_ID, name: 'Org A' },
        { organizationId: ORG_B_ID, name: 'Org B' },
      ]);
      for (const entry of result.organizations) {
        expect(Object.keys(entry as object).sort()).toEqual([
          'name',
          'organizationId',
        ]);
      }
    });

    it('C. le corps de sélection ne contient ni permissions ni membershipId', async () => {
      service = await build();
      usersService.findByEmail.mockResolvedValue(
        makeUserDoc({ password: await hashRight() }),
      );
      organizations.listActiveOrganizations.mockResolvedValue([
        { organizationId: ORG_A_ID, name: 'Org A' },
        { organizationId: ORG_B_ID, name: 'Org B' },
      ]);
      const result = (await service.login(validLogin)) as Record<
        string,
        unknown
      >;
      expect(JSON.stringify(result)).not.toContain('membershipId');
      expect(JSON.stringify(result)).not.toContain('permissions');
    });

    it('D. choix valide → JWT signé avec le contexte résolu (pas l’id brut du body)', async () => {
      service = await build();
      usersService.findByEmail.mockResolvedValue(
        makeUserDoc({ password: await hashRight() }),
      );
      // resolveActiveContext retourne le contexte minimal de 1-3A :
      organizations.resolveActiveContext.mockResolvedValue({
        userId: USER_OBJECT_ID,
        organizationId: ORG_A_ID,
        membershipId: '99',
        role: 'seller',
        permissions: [],
      });

      const { access_token } = await service.login({
        ...validLogin,
        organizationId: ORG_A_ID,
      });

      expect(access_token).toBe('signed-token');
      expect(organizations.resolveActiveContext).toHaveBeenCalledTimes(1);
      expect(organizations.resolveActiveContext).toHaveBeenCalledWith(
        USER_OBJECT_ID,
        ORG_A_ID,
      );
      expect(jwt.sign).toHaveBeenCalledWith({
        sub: USER_OBJECT_ID,
        orgId: ORG_A_ID,
        ver: 0,
        accessScope: 'app',
      });
      // la liste n’est PAS consommée quand un choix est fourni :
      expect(organizations.listActiveOrganizations).not.toHaveBeenCalled();
    });

    it('D. choix inaccessible → refus uniforme 403, aucun JWT', async () => {
      service = await build();
      usersService.findByEmail.mockResolvedValue(
        makeUserDoc({ password: await hashRight() }),
      );
      organizations.resolveActiveContext.mockRejectedValue(
        new ForbiddenException({
          code: ORGANIZATION_ACCESS_DENIED,
          message: "Accès à l'organisation refusé.",
        }),
      );
      const error: unknown = await service
        .login({ ...validLogin, organizationId: ORG_B_ID })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      const response = (error as ForbiddenException).getResponse() as {
        code: string;
      };
      expect(response.code).toBe(ORGANIZATION_ACCESS_DENIED);
      expect(jwt.sign).not.toHaveBeenCalled();
    });
  });

  // ---- signature JWT ----

  describe('sign (payload JWT)', () => {
    it('payload exact : { sub, orgId } — sans email, sans rôle (les claims std iat/exp viennent de JwtModule)', async () => {
      service = await build();
      usersService.findByEmail.mockResolvedValue(
        makeUserDoc({ password: await hashRight() }),
      );
      organizations.listActiveOrganizations.mockResolvedValue([
        { organizationId: ORG_A_ID, name: 'Org A' },
      ]);
      await service.login({
        email: 'ada@example.com',
        password: 'right-password-1',
      });
      expect(jwt.sign).toHaveBeenCalledTimes(1);
      const payload = jwt.sign.mock.calls[0][0] as Record<string, unknown>;
      // 1-13B : `ver` = version de session (absente en base → 0).
      // 1-14C.1 : portée applicative explicite.
      expect(Object.keys(payload).sort()).toEqual([
        'accessScope',
        'orgId',
        'sub',
        'ver',
      ]);
      expect(payload.accessScope).toBe('app');
      expect(payload.ver).toBe(0);
      expect(payload.sub).toBe(USER_OBJECT_ID);
      expect(payload.orgId).toBe(ORG_A_ID);
      expect('email' in payload).toBe(false);
      expect('role' in payload).toBe(false);
    });

    it('1-13B : version courante signée ; ni mot de passe ni version dans `user`', async () => {
      service = await build();
      usersService.findByEmail.mockResolvedValue(
        makeUserDoc({ password: await hashRight(), authVersion: 4 }),
      );
      organizations.listActiveOrganizations.mockResolvedValue([
        { organizationId: ORG_A_ID, name: 'Org A' },
      ]);
      const result = await service.login({
        email: 'ada@example.com',
        password: 'right-password-1',
      });
      expect(jwt.sign).toHaveBeenCalledWith({
        sub: USER_OBJECT_ID,
        orgId: ORG_A_ID,
        ver: 4,
        accessScope: 'app',
      });
      const flat = JSON.stringify(result);
      expect(flat).not.toContain('authVersion');
      expect(flat).not.toContain('password');
    });
  });

  // ---- switch ----

  describe('switchOrganization', () => {
    it('switch valide : le sub provient de l’utilisateur authentifié (jamais du body)', async () => {
      service = await build();
      usersService.findByIdForAuth.mockResolvedValue(
        makeUserDoc({ authVersion: 3 }),
      );
      organizations.resolveActiveContext.mockResolvedValue({
        userId: USER_OBJECT_ID,
        organizationId: ORG_B_ID,
        membershipId: '99',
        role: 'seller',
        permissions: [],
      });

      const { access_token } = await service.switchOrganization(
        USER_OBJECT_ID,
        {
          organizationId: ORG_B_ID,
        },
        3,
        AccessScope.APP,
      );

      expect(access_token).toBe('signed-token');
      expect(organizations.resolveActiveContext).toHaveBeenCalledWith(
        USER_OBJECT_ID,
        ORG_B_ID,
      );
      // 1-13B : version validée du JWT appelant, confirmée en base.
      expect(jwt.sign).toHaveBeenCalledWith({
        sub: USER_OBJECT_ID,
        orgId: ORG_B_ID,
        ver: 3,
        accessScope: 'app',
      });
    });

    it('1-13B : version en base plus récente que le JWT appelant (réinitialisation concurrente) → 401 SESSION_REVOKED, aucun JWT', async () => {
      service = await build();
      usersService.findByIdForAuth.mockResolvedValue(
        makeUserDoc({ authVersion: 4 }),
      );
      organizations.resolveActiveContext.mockResolvedValue({
        userId: USER_OBJECT_ID,
        organizationId: ORG_B_ID,
        membershipId: '99',
        role: 'seller',
        permissions: [],
      });
      const error: unknown = await service
        .switchOrganization(
          USER_OBJECT_ID,
          { organizationId: ORG_B_ID },
          3,
          AccessScope.APP,
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).getResponse()).toMatchObject({
        code: 'SESSION_REVOKED',
      });
      expect(jwt.sign).not.toHaveBeenCalled();
    });

    it('1-13B : jamais d’élévation — signé avec la version du JWT appelant', async () => {
      service = await build();
      usersService.findByIdForAuth.mockResolvedValue(makeUserDoc());
      organizations.resolveActiveContext.mockResolvedValue({
        userId: USER_OBJECT_ID,
        organizationId: ORG_B_ID,
        membershipId: '99',
        role: 'seller',
        permissions: [],
      });
      await service.switchOrganization(
        USER_OBJECT_ID,
        { organizationId: ORG_B_ID },
        0,
        AccessScope.APP,
      );
      expect(jwt.sign).toHaveBeenCalledWith({
        sub: USER_OBJECT_ID,
        orgId: ORG_B_ID,
        ver: 0,
        accessScope: 'app',
      });
    });

    it('switch inaccessible → refus uniforme 403, aucun JWT', async () => {
      service = await build();
      organizations.resolveActiveContext.mockRejectedValue(
        new ForbiddenException({
          code: ORGANIZATION_ACCESS_DENIED,
          message: "Accès à l'organisation refusé.",
        }),
      );
      const error: unknown = await service
        .switchOrganization(
          USER_OBJECT_ID,
          { organizationId: ORG_B_ID },
          0,
          AccessScope.APP,
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(
        ((error as ForbiddenException).getResponse() as { code: string }).code,
      ).toBe(ORGANIZATION_ACCESS_DENIED);
      expect(jwt.sign).not.toHaveBeenCalled();
    });
  });
});

// Note : la durée de 7 jours n’est pas assertée ici (claim `exp` injecté par
// le JwtModule — `signOptions: { expiresIn: '7d' }` d'AuthModule, inchangé) ;
// elle est prouvée en E2E (écart iat→exp ≈ 7 jours).
