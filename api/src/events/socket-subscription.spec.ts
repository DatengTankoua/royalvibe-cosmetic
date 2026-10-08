import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MAX_TIMER_DELAY_MS,
  SOCKET_AUTH_TOKEN_KEY,
  installSocketAuthMiddleware,
  scheduleSocketSubscriptionCheck,
} from './socket-auth.middleware';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import type { SubscriptionAccessDecision } from '../subscriptions/subscription-access';

/**
 * 1-14C.1 — contrôle commercial des sockets (handshake + échéance de
 * couverture) et portée du JWT HTTP. Fake timers : aucun délai réel,
 * ordre des événements déterministe.
 */

const USER_ID = '0123456789abcdef01234567';
const ORG_ID = '0123456789abcdef01234568';
const T0 = new Date('2026-06-01T00:00:00.000Z').getTime();

function decision(
  active: boolean,
  coverageEndsAt: number | null,
): SubscriptionAccessDecision {
  return {
    state: active ? 'active' : 'expired',
    active,
    coverageEndsAt: coverageEndsAt === null ? null : new Date(coverageEndsAt),
    checkedAt: new Date(T0),
  };
}

function makeSocket(coverageEndsAt?: number) {
  const listeners = new Map<string, () => void>();
  return {
    handshake: { auth: { [SOCKET_AUTH_TOKEN_KEY]: 'token' } },
    data: { subscriptionCoverageEndsAt: coverageEndsAt } as Record<
      string,
      unknown
    >,
    disconnect: jest.fn(),
    once: jest.fn((event: string, fn: () => void) => listeners.set(event, fn)),
    off: jest.fn((event: string) => listeners.delete(event)),
    fireDisconnect: () => listeners.get('disconnect')?.(),
  };
}

describe('scheduleSocketSubscriptionCheck (1-14C.1)', () => {
  let now: number;
  const clock = () => new Date(now);

  beforeEach(() => {
    jest.useFakeTimers();
    now = T0;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  async function advance(ms: number) {
    now += ms;
    await jest.advanceTimersByTimeAsync(ms);
  }

  it('échéance + état inactif relu → socket fermé', async () => {
    const socket = makeSocket(T0 + 1000);
    const readDecision = jest
      .fn()
      .mockResolvedValue(decision(false, T0 + 1000));
    scheduleSocketSubscriptionCheck(socket as never, {
      readDecision,
      now: clock,
    });

    await advance(999);
    expect(readDecision).not.toHaveBeenCalled();
    await advance(1);
    expect(readDecision).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('renouvellement avant l’échéance → couverture mise à jour, reprogrammé, socket conservé', async () => {
    const socket = makeSocket(T0 + 1000);
    const readDecision = jest
      .fn()
      .mockResolvedValueOnce(decision(true, T0 + 5000))
      .mockResolvedValueOnce(decision(false, T0 + 5000));
    scheduleSocketSubscriptionCheck(socket as never, {
      readDecision,
      now: clock,
    });

    await advance(1000);
    expect(readDecision).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.data.subscriptionCoverageEndsAt).toBe(T0 + 5000);

    await advance(3999);
    expect(readDecision).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(readDecision).toHaveBeenCalledTimes(2);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('lecture impossible à l’échéance → fermeture (fail-closed)', async () => {
    const socket = makeSocket(T0 + 10);
    const readDecision = jest.fn().mockRejectedValue(new Error('db down'));
    scheduleSocketSubscriptionCheck(socket as never, {
      readDecision,
      now: clock,
    });
    await advance(10);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('déconnexion avant l’échéance → timer nettoyé, aucune lecture', async () => {
    const socket = makeSocket(T0 + 1000);
    const readDecision = jest.fn();
    scheduleSocketSubscriptionCheck(socket as never, {
      readDecision,
      now: clock,
    });
    socket.fireDisconnect();
    await advance(5000);
    expect(readDecision).not.toHaveBeenCalled();
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('déconnexion PENDANT la relecture → aucune fermeture ni reprogrammation', async () => {
    const socket = makeSocket(T0 + 10);
    let release!: (d: SubscriptionAccessDecision) => void;
    const readDecision = jest.fn(
      () =>
        new Promise<SubscriptionAccessDecision>((resolve) => {
          release = resolve;
        }),
    );
    scheduleSocketSubscriptionCheck(socket as never, {
      readDecision,
      now: clock,
    });
    await advance(10);
    expect(readDecision).toHaveBeenCalledTimes(1);
    socket.fireDisconnect();
    release(decision(true, T0 + 100_000));
    await jest.advanceTimersByTimeAsync(0);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('couverture très lointaine → délai borné (relecture intermédiaire, pas de déclenchement immédiat)', async () => {
    const far = T0 + MAX_TIMER_DELAY_MS * 3;
    const socket = makeSocket(far);
    const readDecision = jest.fn().mockResolvedValue(decision(true, far));
    scheduleSocketSubscriptionCheck(socket as never, {
      readDecision,
      now: clock,
    });
    await advance(1);
    expect(readDecision).not.toHaveBeenCalled();
    await advance(MAX_TIMER_DELAY_MS - 1);
    expect(readDecision).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});

describe('installSocketAuthMiddleware — contrôle commercial (1-14C.1)', () => {
  function build(payload: Record<string, unknown>, access: unknown) {
    const deps = {
      jwtService: { verifyAsync: jest.fn().mockResolvedValue(payload) },
      usersService: {
        findByIdForAuth: jest.fn().mockResolvedValue({
          _id: { toString: () => USER_ID },
          email: 'u@example.com',
          role: 'seller',
          emailVerifiedAt: new Date(),
        }),
      },
      organizationsService: {
        resolveActiveContext: jest.fn().mockResolvedValue({
          userId: USER_ID,
          organizationId: ORG_ID,
          membershipId: 'm',
          role: 'seller',
          permissions: [],
        }),
      },
      subscriptionsService: {
        getAccessDecision:
          access instanceof Error
            ? jest.fn().mockRejectedValue(access)
            : jest.fn().mockResolvedValue(access),
        now: jest.fn(() => new Date()),
      },
      logger: { warn: jest.fn(), error: jest.fn() },
    };
    const use = jest.fn();
    installSocketAuthMiddleware({ use } as never, deps as never);
    const middleware = use.mock.calls[0][0] as (
      socket: unknown,
      next: (err?: Error) => void,
    ) => void;
    return { deps, middleware };
  }

  const basePayload = () => ({
    sub: USER_ID,
    orgId: ORG_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const future = () => new Date(Date.now() + 3_600_000);

  async function run(payload: Record<string, unknown>, access: unknown) {
    const { deps, middleware } = build(payload, access);
    const socket = makeSocket();
    const next = jest.fn();
    middleware(socket, next);
    await new Promise((resolve) => setImmediate(resolve));
    return { deps, socket, next };
  }

  it('JWT applicatif + abonnement actif → accepté, couverture mémorisée', async () => {
    const end = future();
    const { socket, next } = await run(
      { ...basePayload(), accessScope: 'app' },
      {
        state: 'active',
        active: true,
        coverageEndsAt: end,
        checkedAt: new Date(),
      },
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();
    expect(socket.data.subscriptionCoverageEndsAt).toBe(end.getTime());
    socket.fireDisconnect();
  });

  it.each([
    ['jeton limité', 'subscription_limited'],
    ['portée inconnue', 'admin'],
    ['portée mal typée', 1],
  ])('%s → refus avant toute requête DB', async (_label, scope) => {
    const { deps, socket, next } = await run(
      { ...basePayload(), accessScope: scope },
      {
        state: 'active',
        active: true,
        coverageEndsAt: future(),
        checkedAt: new Date(),
      },
    );
    expect((next.mock.calls[0] as [Error])[0].message).toBe('unauthorized');
    expect(deps.usersService.findByIdForAuth).not.toHaveBeenCalled();
    expect(socket.data.user).toBeUndefined();
  });

  it.each([
    [
      'expiré',
      {
        state: 'expired',
        active: false,
        coverageEndsAt: new Date(0),
        checkedAt: new Date(),
      },
    ],
    [
      'sans période',
      {
        state: 'none',
        active: false,
        coverageEndsAt: null,
        checkedAt: new Date(),
      },
    ],
    [
      'programmé',
      {
        state: 'scheduled',
        active: false,
        coverageEndsAt: future(),
        checkedAt: new Date(),
      },
    ],
    ['lecture impossible', new Error('db down')],
  ])(
    'abonnement %s → refus générique, aucun principal',
    async (_label, access) => {
      const { socket, next } = await run(basePayload(), access);
      expect((next.mock.calls[0] as [Error])[0].message).toBe('unauthorized');
      expect(socket.data.user).toBeUndefined();
      expect(socket.disconnect).not.toHaveBeenCalled();
    },
  );
});

describe('JwtStrategy — portée du JWT (1-14C.1)', () => {
  const user = {
    _id: { toString: () => USER_ID },
    name: 'Ada',
    email: 'ada@example.com',
    role: 'seller',
    emailVerifiedAt: new Date(),
  };

  function strategy() {
    const usersService = { findByIdForAuth: jest.fn().mockResolvedValue(user) };
    const config = {
      getOrThrow: () => 'unit-secret',
    } as unknown as ConfigService;
    return {
      usersService,
      strategy: new JwtStrategy(config, usersService as never),
    };
  }

  it('portée limitée portée par le principal', async () => {
    const { strategy: s } = strategy();
    await expect(
      s.validate({
        sub: USER_ID,
        orgId: ORG_ID,
        accessScope: 'subscription_limited',
      } as never),
    ).resolves.toMatchObject({ accessScope: 'subscription_limited' });
  });

  it.each([
    ['inconnue', 'root'],
    ['nombre', 0],
    ['null', null],
    ['objet', {}],
  ])('portée %s → 401, aucune requête DB', async (_label, scope) => {
    const { strategy: s, usersService } = strategy();
    await expect(
      s.validate({ sub: USER_ID, orgId: ORG_ID, accessScope: scope } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(usersService.findByIdForAuth).not.toHaveBeenCalled();
  });
});
