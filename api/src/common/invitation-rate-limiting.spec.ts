import { ExecutionContext, HttpException } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageRecord } from '@nestjs/throttler';
import {
  INVITATION_CREATE_BLOCK,
  INVITATION_CREATE_LIMIT,
  INVITATION_CREATE_NAME,
  INVITATION_CREATE_TTL,
  INVITATION_RATE_LIMIT_CODE,
  INVITATION_RATE_LIMIT_MESSAGE,
  InvitationCreateThrottlerGuard,
  buildInvitationRateLimitBody,
  createInvitationThrottlerWindow,
} from './invitation-rate-limiting';

/**
 * Tests unitaires du rate limiting de POST /organizations/invitations
 * (correction sécurité 1-10B). Pas d'assertion sur des détails privés de
 * `@nestjs/throttler` : storage simulé (pas de temporisation réelle 60 s).
 */
describe('invitation-rate-limiting (1-10B)', () => {
  describe('createInvitationThrottlerWindow', () => {
    it('définit la fenêtre exacte (5 créations / 60 s, blocage 60 s)', () => {
      expect(createInvitationThrottlerWindow()).toEqual({
        name: 'invitation-create',
        limit: 5,
        ttl: 60_000,
        blockDuration: 60_000,
      });
      expect(INVITATION_CREATE_NAME).toBe('invitation-create');
      expect(INVITATION_CREATE_LIMIT).toBe(5);
      expect(INVITATION_CREATE_TTL).toBe(60_000);
      expect(INVITATION_CREATE_BLOCK).toBe(60_000);
    });
  });

  describe('buildInvitationRateLimitBody / code stable', () => {
    it('renvoie exactement le triple stable { statusCode, code, message }', () => {
      expect(buildInvitationRateLimitBody()).toEqual({
        statusCode: 429,
        code: INVITATION_RATE_LIMIT_CODE,
        message: INVITATION_RATE_LIMIT_MESSAGE,
      });
      expect(INVITATION_RATE_LIMIT_CODE).toBe('INVITATION_RATE_LIMITED');
    });

    it('ne porte jamais d’email, de token, de rôle ni de compteur', () => {
      expect(Object.keys(buildInvitationRateLimitBody()).sort()).toEqual([
        'code',
        'message',
        'statusCode',
      ]);
    });
  });

  describe('InvitationCreateThrottlerGuard.getTracker', () => {
    const buildGuard = (storage: ThrottlerStorage) =>
      new InvitationCreateThrottlerGuard(
        { setHeaders: false, throttlers: [createInvitationThrottlerWindow()] },
        storage,
        { getAllAndOverride: () => undefined } as never,
      );

    it('compose userId:organizationId — jamais IP/email/token', async () => {
      const guard = buildGuard({ increment: jest.fn() });
      const tracker = await (
        guard as unknown as {
          getTracker: (req: unknown) => Promise<string>;
        }
      ).getTracker({
        user: { _id: { toString: () => 'user-123' } },
        organizationContext: { organizationId: 'org-456' },
        ip: '9.9.9.9',
        headers: { authorization: 'Bearer some-token' },
      });
      expect(tracker).toBe('user-123:org-456');
      expect(tracker).not.toContain('9.9.9.9');
      expect(tracker).not.toContain('token');
    });

    it('userId/organizationId absents → repli explicite (jamais une exception)', async () => {
      const guard = buildGuard({ increment: jest.fn() });
      const tracker = await (
        guard as unknown as {
          getTracker: (req: unknown) => Promise<string>;
        }
      ).getTracker({});
      expect(tracker).toBe('unknown-user:unknown-org');
    });

    it('deux organisations différentes pour le MÊME utilisateur → trackers distincts', async () => {
      const guard = buildGuard({ increment: jest.fn() });
      const getTracker = (
        guard as unknown as {
          getTracker: (req: unknown) => Promise<string>;
        }
      ).getTracker.bind(guard);
      const trackerOrgA = await getTracker({
        user: { _id: { toString: () => 'user-1' } },
        organizationContext: { organizationId: 'org-A' },
      });
      const trackerOrgB = await getTracker({
        user: { _id: { toString: () => 'user-1' } },
        organizationContext: { organizationId: 'org-B' },
      });
      expect(trackerOrgA).not.toBe(trackerOrgB);
    });
  });

  describe('InvitationCreateThrottlerGuard (comportement de limite)', () => {
    const makeContext = (res: Record<string, unknown>): ExecutionContext =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            user: { _id: { toString: () => 'user-1' } },
            organizationContext: { organizationId: 'org-1' },
            headers: {},
          }),
          getResponse: () => res,
        }),
        getHandler: () => ({ name: 'create' }),
        getClass: () => class FakeClass {},
      }) as unknown as ExecutionContext;

    const makeStorage = (record: ThrottlerStorageRecord): ThrottlerStorage => ({
      increment: jest.fn().mockResolvedValue(record),
    });

    const buildGuard = (storage: ThrottlerStorage) =>
      new InvitationCreateThrottlerGuard(
        { setHeaders: false, throttlers: [createInvitationThrottlerWindow()] },
        storage,
        { getAllAndOverride: () => undefined } as never,
      );

    it('avant la limite → canActivate autorise (aucun jet)', async () => {
      const guard = buildGuard(
        makeStorage({
          totalHits: 3,
          timeToExpire: 59,
          isBlocked: false,
          timeToBlockExpire: 0,
        }),
      );
      const res: Record<string, unknown> = {};
      expect(await guard.canActivate(makeContext(res))).toBe(true);
      expect(res).toEqual({});
    });

    it('limite dépassée → 429, corps stable INVITATION_RATE_LIMITED, Retry-After positif', async () => {
      const guard = buildGuard(
        makeStorage({
          totalHits: 6,
          timeToExpire: 50,
          isBlocked: true,
          timeToBlockExpire: 45,
        }),
      );
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
      expect(exc.getResponse()).toEqual(buildInvitationRateLimitBody());
      expect(JSON.stringify(exc.getResponse())).not.toMatch(
        /email|token|apiKey|permission/i,
      );
      expect(headers['Retry-After']).toBeDefined();
      const ra = Number(headers['Retry-After']);
      expect(Number.isInteger(ra)).toBe(true);
      expect(ra).toBeGreaterThan(0);
    });
  });
});
