import { ExecutionContext, HttpException } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageRecord } from '@nestjs/throttler';
import {
  AUTH_RATE_LIMIT_CODE,
  AUTH_RATE_LIMIT_MESSAGE,
  AuthThrottlerGuard,
  buildAuthRateLimitBody,
  computeRetryAfterSeconds,
  createAuthThrottlerOptions,
  resolveTrustProxyHops,
} from './auth-rate-limiting';

/**
 * Tests unitaires du rate limiting de POST /auth/login (phase 0B.6).
 *
 * Pas d'assertion sur des détails privés de `@nestjs/throttler` : on teste
 * uniquement les surfaces publiques de cette phase (options, corps stable,
 * `Retry-After`, parsing `TRUST_PROXY_HOPS`). Le storage est simulé (pas de
 * temporisation réelle 60 s / 15 min).
 */
describe('auth-rate-limiting (0B.6)', () => {
  describe('createAuthThrottlerOptions', () => {
    it('définit les deux fenêtres nommées exactes (limites, ttl, blocage) + helpers officiels', () => {
      expect(createAuthThrottlerOptions()).toEqual({
        setHeaders: false,
        throttlers: [
          {
            name: 'login-short',
            limit: 10,
            ttl: 60_000,
            blockDuration: 60_000,
          },
          {
            name: 'login-long',
            limit: 30,
            ttl: 900_000,
            blockDuration: 900_000,
          },
        ],
      });
    });

    it("n'expose aucun en-tête automatique (setHeaders: false) pour cacher le compteur restant", () => {
      expect(createAuthThrottlerOptions()).toMatchObject({
        setHeaders: false,
      });
    });
  });

  describe('buildAuthRateLimitBody / code stable', () => {
    it('renvoie exactement le triple stable { statusCode, code, message }', () => {
      expect(buildAuthRateLimitBody()).toEqual({
        statusCode: 429,
        code: AUTH_RATE_LIMIT_CODE,
        message: AUTH_RATE_LIMIT_MESSAGE,
      });
      expect(AUTH_RATE_LIMIT_CODE).toBe('AUTH_RATE_LIMITED');
      expect(AUTH_RATE_LIMIT_MESSAGE).toBe(
        'Trop de tentatives de connexion. Réessayez plus tard.',
      );
    });

    it('ne porte jamais de mot de passe, token, e-mail ni compteur de tentatives', () => {
      expect(Object.keys(buildAuthRateLimitBody()).sort()).toEqual([
        'code',
        'message',
        'statusCode',
      ]);
    });
  });

  describe('computeRetryAfterSeconds', () => {
    it('renvoie un entier strictement positif (en secondes, plafonné)', () => {
      expect(computeRetryAfterSeconds(57_000)).toBe(57);
      expect(computeRetryAfterSeconds(56_500)).toBe(57);
      expect(computeRetryAfterSeconds(1_000)).toBe(1);
      expect(computeRetryAfterSeconds(999)).toBe(1);
    });

    it('renvoie undefined pour 0, négatif ou NaN (l’en-tête n’est pas émis)', () => {
      expect(computeRetryAfterSeconds(0)).toBeUndefined();
      expect(computeRetryAfterSeconds(-1)).toBeUndefined();
      expect(computeRetryAfterSeconds(Number.NaN)).toBeUndefined();
    });
  });

  describe('resolveTrustProxyHops', () => {
    it.each([
      ['absent (undefined)', undefined, 0],
      ['vide ("")', '', 0],
      ['0', '0', 0],
      ['1', '1', 1],
      ['entier supérieur ("3")', '3', 3],
    ])('accepte la valeur %s', (_label, raw, expected) => {
      expect(resolveTrustProxyHops(raw)).toBe(expected);
    });

    it.each([
      ['négatif ("-1")', '-1'],
      ['décimal ("1.5")', '1.5'],
      ['texte ("un")', 'un'],
      ['ambiguë ("1x")', '1x'],
      ['hors plage safe-integer', '99999999999999999999'],
    ])('refuse %s avec une erreur claire au démarrage', (_label, raw) => {
      expect(() => resolveTrustProxyHops(raw)).toThrow();
    });
  });

  describe('AuthThrottlerGuard (comportement de limite)', () => {
    const makeContext = (res: Record<string, unknown>): ExecutionContext =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ ip: '1.2.3.4', headers: { 'user-agent': 't' } }),
          getResponse: () => res,
        }),
        getHandler: () => ({ name: 'login' }),
        getClass: () => class FakeClass {},
      }) as unknown as ExecutionContext;

    const makeStorage = (record: ThrottlerStorageRecord): ThrottlerStorage => ({
      increment: jest.fn().mockResolvedValue(record),
    });

    const buildGuard = (storage: ThrottlerStorage) =>
      new AuthThrottlerGuard(
        createAuthThrottlerOptions(),
        storage,
        // Reflector minimal : toutes les méthodes retournent undefined →
        // le garde retombe sur la config de module (fenêtres nommées).
        { getAllAndOverride: () => undefined } as never,
      );

    it('avant la limite → canActivate autorise (aucun jet)', async () => {
      const guard = buildGuard(
        makeStorage({
          totalHits: 1,
          timeToExpire: 59,
          isBlocked: false,
          timeToBlockExpire: 0,
        }),
      );
      await guard.onModuleInit();
      const res: Record<string, unknown> = {};
      expect(await guard.canActivate(makeContext(res))).toBe(true);
      expect(res).toEqual({});
    });

    it('limite dépassée → 429, corps stable, Retry-After positif, AUCUNE donnée d’auth', async () => {
      const guard = buildGuard(
        makeStorage({
          totalHits: 11,
          timeToExpire: 50,
          isBlocked: true,
          timeToBlockExpire: 45,
        }),
      );
      await guard.onModuleInit();
      const headers: Record<string, string> = {};
      const res: Record<string, unknown> = {
        setHeader: (name: string, value: string) => {
          headers[name] = value;
        },
      };
      const ctx = makeContext(res);

      let error: unknown;
      try {
        await guard.canActivate(ctx);
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(HttpException);
      const exc = error as HttpException;
      expect(exc.getStatus()).toBe(429);
      // Corps STABLE (exact) : aucun mot de passe, token, e-mail ou compteur.
      expect(exc.getResponse()).toEqual(buildAuthRateLimitBody());
      // Retry-After présent, en secondes entières strictement positives.
      expect(headers['Retry-After']).toBeDefined();
      const ra = Number(headers['Retry-After']);
      expect(Number.isInteger(ra)).toBe(true);
      expect(ra).toBeGreaterThan(0);
    });
  });
});
