import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtStrategy } from './jwt.strategy';
import { UsersService } from '../../users/users.service';

const USER_ID = '112233445566778899001122';
const ORG_ID = '223344556677889900112233';
const INVALID_ID = 'not-an-object-id';

/** Utilisateur minimal renvoyé par UsersService (rôle chargé DB). */
function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: USER_ID,
    name: 'Ada',
    email: 'ada@example.com',
    role: 'seller',
    // 1-13A : adresse vérifiée (jamais recopiée dans le principal).
    emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** Principal attendu : champs explicites seulement (jamais l'état interne). */
function expectedPrincipal(overrides: Record<string, unknown> = {}) {
  const {
    emailVerifiedAt: _verified,
    authVersion: _version,
    ...user
  } = makeUser(overrides) as Record<string, unknown>;
  void _verified;
  // 1-13B : version de session validée, portée par le principal.
  const sessionVersion = typeof _version === 'number' ? _version : 0;
  // 1-14C.1 : claim de portée absent (historique) → `app`.
  return {
    ...user,
    organizationId: ORG_ID,
    sessionVersion,
    accessScope: 'app',
  };
}

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let usersService: { findByIdForAuth: jest.Mock };

  async function build() {
    usersService = { findByIdForAuth: jest.fn() };
    const config = new ConfigService();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => 'test-secret' },
        },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile();
    strategy = module.get(JwtStrategy);
    void config;
    return strategy;
  }

  // 13. payload valide
  it('payload { sub, orgId } valide + utilisateur présent → renvoie l’utilisateur (rôle depuis la base)', async () => {
    await build();
    usersService.findByIdForAuth.mockReturnValue(makeUser());

    const user = await strategy.validate({
      sub: USER_ID,
      orgId: ORG_ID,
      email: 'forged@example.com',
      role: 'admin',
    } as never);

    // Le claim `orgId` signé est attaché au principal sous `organizationId`
    // (1-3B.2) : c'est la source UNIQUE de l'organisation pour
    // `OrganizationGuard` (jamais d'origine client).
    expect(user).toEqual(expectedPrincipal());
    expect(usersService.findByIdForAuth).toHaveBeenCalledTimes(1);
    expect(usersService.findByIdForAuth).toHaveBeenCalledWith(USER_ID);
    // le rôle retourné provient DU DOCUMENT CHARGÉ (ici 'seller'), JAMAIS du
    // JWT (qui portait 'admin') :
    expect(user.role).toBe('seller');
  });

  // 14. sub absent/invalide
  it.each([
    ['sub absent', { orgId: ORG_ID }],
    ['sub invalide', { sub: INVALID_ID, orgId: ORG_ID }],
    ['sub vide', { sub: '', orgId: ORG_ID }],
    ['sub non-string', { sub: 42, orgId: ORG_ID }],
  ])(
    '%s → 401 contrôlée, sans requête vers la base',
    async (_label, payload) => {
      await build();
      usersService.findByIdForAuth.mockReturnValue(makeUser());

      const error: unknown = await strategy
        .validate(payload as never)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(usersService.findByIdForAuth).not.toHaveBeenCalled();
    },
  );

  // 15. orgId absent/invalide
  it.each([
    ['orgId absent', { sub: USER_ID }],
    ['orgId invalide', { sub: USER_ID, orgId: INVALID_ID }],
    ['orgId vide', { sub: USER_ID, orgId: '' }],
    ['orgId non-string', { sub: USER_ID, orgId: 42 }],
  ])(
    '%s → 401 contrôlée, sans requête vers la base',
    async (_label, payload) => {
      await build();
      usersService.findByIdForAuth.mockReturnValue(makeUser());

      const error: unknown = await strategy
        .validate(payload as never)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(usersService.findByIdForAuth).not.toHaveBeenCalled();
    },
  );

  // 1-13A : adresse non vérifiée — un JWT signé et non expiré ne suffit pas.
  it.each([
    ['absent', undefined],
    ['null', null],
  ])(
    'emailVerifiedAt %s → 401 EMAIL_NOT_VERIFIED (ancien JWT refusé)',
    async (_label, value) => {
      await build();
      usersService.findByIdForAuth.mockReturnValue(
        makeUser({ emailVerifiedAt: value }),
      );
      const error: unknown = await strategy
        .validate({ sub: USER_ID, orgId: ORG_ID })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).getResponse()).toMatchObject({
        code: 'EMAIL_NOT_VERIFIED',
      });
    },
  );

  // 1-13B : version de session (claim `ver`) comparée à la base.
  it.each([
    ['claim absent, version absente (historique)', {}, undefined],
    ['claim 0, version absente', { ver: 0 }, undefined],
    ['claim 2, version 2', { ver: 2 }, 2],
  ])('%s → accepté', async (_label, claims, authVersion) => {
    await build();
    usersService.findByIdForAuth.mockReturnValue(makeUser({ authVersion }));
    const user = await strategy.validate({
      sub: USER_ID,
      orgId: ORG_ID,
      ...claims,
    });
    expect(user).toEqual(expectedPrincipal({ authVersion }));
    expect(JSON.stringify(user)).not.toContain('authVersion');
  });

  it.each([
    ['claim absent, version 1 (réinitialisé)', {}, 1],
    ['claim 1, version 2', { ver: 1 }, 2],
    ['claim chaîne "1"', { ver: '1' }, 1],
    ['claim décimal', { ver: 1.5 }, 1],
    ['claim négatif', { ver: -1 }, 0],
    ['claim null', { ver: null }, 0],
  ])('%s → 401 SESSION_REVOKED', async (_label, claims, authVersion) => {
    await build();
    usersService.findByIdForAuth.mockReturnValue(makeUser({ authVersion }));
    const error: unknown = await strategy
      .validate({ sub: USER_ID, orgId: ORG_ID, ...claims })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toMatchObject({
      code: 'SESSION_REVOKED',
    });
  });

  // 16. utilisateur absent
  it('utilisateur inexistant (sub/orgId valides) → 401', async () => {
    await build();
    usersService.findByIdForAuth.mockReturnValue(null);

    const error: unknown = await strategy
      .validate({ sub: USER_ID, orgId: ORG_ID })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect(usersService.findByIdForAuth).toHaveBeenCalledWith(USER_ID);
  });

  // 17. rôle chargé depuis la base, jamais depuis le JWT
  it('le rôle retourné est toujours celui du document chargé (pas celui du JWT)', async () => {
    await build();
    usersService.findByIdForAuth.mockReturnValue(makeUser({ role: 'admin' }));

    const user = await strategy.validate({
      sub: USER_ID,
      orgId: ORG_ID,
      role: 'seller',
    } as never);

    expect(user.role).toBe('admin');
  });

  // 18. ObjectId STRICT : chaque forme non-canonique doit être refusée
  // AVANT toute requête DB (sub ET orgId) — `isValidObjectId()` (cast) ne
  // suffit pas ; seul string+24hex est accepté.
  const STRICT_REJECTIONS: Array<[string, 'sub' | 'orgId', unknown]> = [
    ['nombre', 'sub', 1234],
    ['booléen', 'sub', true],
    ['objet', 'sub', { _id: ORG_ID }],
    ['tableau', 'sub', [ORG_ID]],
    ['null', 'sub', null],
    ['undefinied', 'sub', undefined],
    ['chaîne vide', 'sub', ''],
    ['12 caractères non-hex', 'sub', 'ghijklmnop'],
    ['24 caractères dont un non-hex', 'sub', '1122334455667788990011gg'],
    ['nombre', 'orgId', 1234],
    ['booléen', 'orgId', true],
    ['objet', 'orgId', { _id: USER_ID }],
    ['tableau', 'orgId', [USER_ID]],
    ['null', 'orgId', null],
    ['undefinied', 'orgId', undefined],
    ['chaîne vide', 'orgId', ''],
    ['12 caractères non-hex', 'orgId', 'ghijklmnop'],
    ['24 caractères dont un non-hex', 'orgId', '2233445566778899001122gg'],
  ];

  it.each(STRICT_REJECTIONS)(
    'ObjectId strict : %s sur %s → 401 contrôlée, sans requête vers la base',
    async (_label, field, value) => {
      await build();
      usersService.findByIdForAuth.mockReturnValue(makeUser());
      const payload = {
        sub: field === 'sub' ? value : USER_ID,
        orgId: field === 'orgId' ? value : ORG_ID,
      };
      const error: unknown = await strategy
        .validate(payload as never)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(usersService.findByIdForAuth).not.toHaveBeenCalled();
    },
  );
});
