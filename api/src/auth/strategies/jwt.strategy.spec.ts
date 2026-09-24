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
    ...overrides,
  };
}

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let usersService: { findById: jest.Mock };

  async function build() {
    usersService = { findById: jest.fn() };
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
    usersService.findById.mockReturnValue(makeUser());

    const user = await strategy.validate({
      sub: USER_ID,
      orgId: ORG_ID,
      email: 'forged@example.com',
      role: 'admin',
    } as never);

    expect(user).toEqual(makeUser());
    expect(usersService.findById).toHaveBeenCalledTimes(1);
    expect(usersService.findById).toHaveBeenCalledWith(USER_ID);
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
      usersService.findById.mockReturnValue(makeUser());

      const error: unknown = await strategy
        .validate(payload as never)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(usersService.findById).not.toHaveBeenCalled();
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
      usersService.findById.mockReturnValue(makeUser());

      const error: unknown = await strategy
        .validate(payload as never)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(usersService.findById).not.toHaveBeenCalled();
    },
  );

  // 16. utilisateur absent
  it('utilisateur inexistant (sub/orgId valides) → 401', async () => {
    await build();
    usersService.findById.mockReturnValue(null);

    const error: unknown = await strategy
      .validate({ sub: USER_ID, orgId: ORG_ID })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect(usersService.findById).toHaveBeenCalledWith(USER_ID);
  });

  // 17. rôle chargé depuis la base, jamais depuis le JWT
  it('le rôle retourné est toujours celui du document chargé (pas celui du JWT)', async () => {
    await build();
    usersService.findById.mockReturnValue(makeUser({ role: 'admin' }));

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
      usersService.findById.mockReturnValue(makeUser());
      const payload = {
        sub: field === 'sub' ? value : USER_ID,
        orgId: field === 'orgId' ? value : ORG_ID,
      };
      const error: unknown = await strategy
        .validate(payload as never)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(usersService.findById).not.toHaveBeenCalled();
    },
  );
});
