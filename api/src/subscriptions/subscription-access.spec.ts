import 'reflect-metadata';
import {
  ArgumentsHost,
  ExecutionContext,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionAccessGuard } from '../auth/guards/subscription-access.guard';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import {
  AccessScope,
  SUBSCRIPTION_ACCESS_EXEMPTION_KEY,
  SubscriptionAccessDecision,
  accessScopeFromClaims,
  subscriptionInactiveException,
  toSubscriptionAccessView,
} from './subscription-access';

const ORG_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const CHECKED_AT = new Date('2026-06-01T00:00:00.000Z');
const ACTIVE: SubscriptionAccessDecision = {
  state: 'active',
  active: true,
  coverageEndsAt: new Date('2026-07-01T00:00:00.000Z'),
  checkedAt: CHECKED_AT,
};
const EXPIRED: SubscriptionAccessDecision = {
  state: 'expired',
  active: false,
  coverageEndsAt: new Date('2026-05-01T00:00:00.000Z'),
  checkedAt: CHECKED_AT,
};

describe('accessScopeFromClaims (1-14C.1)', () => {
  it('claim absent (JWT historique) → app', () => {
    expect(accessScopeFromClaims({ sub: 'x' })).toBe(AccessScope.APP);
    expect(accessScopeFromClaims(undefined)).toBe(AccessScope.APP);
  });

  it('valeurs exactes acceptées', () => {
    expect(accessScopeFromClaims({ accessScope: 'app' })).toBe(AccessScope.APP);
    expect(accessScopeFromClaims({ accessScope: 'subscription_limited' })).toBe(
      AccessScope.SUBSCRIPTION_LIMITED,
    );
  });

  it.each([
    ['inconnue', 'admin'],
    ['casse différente', 'APP'],
    ['espaces', ' app'],
    ['nombre', 1],
    ['null', null],
    ['undefined explicite', undefined],
    ['objet', { scope: 'app' }],
    ['tableau', ['app']],
    ['booléen', true],
  ])('présente mais %s → null (aucune conversion)', (_label, value) => {
    expect(accessScopeFromClaims({ accessScope: value })).toBeNull();
  });
});

describe('toSubscriptionAccessView (1-14C.1)', () => {
  it('accès applicatif = JWT applicatif ET abonnement actif ; canRenew = propriétaire réel', () => {
    expect(
      toSubscriptionAccessView(ACTIVE, {
        isOwner: true,
        scope: AccessScope.APP,
      }),
    ).toEqual({
      subscriptionState: 'active',
      applicationAccess: true,
      coverageEndsAt: '2026-07-01T00:00:00.000Z',
      checkedAt: '2026-06-01T00:00:00.000Z',
      canRenew: true,
    });
    expect(
      toSubscriptionAccessView(ACTIVE, {
        isOwner: false,
        scope: AccessScope.SUBSCRIPTION_LIMITED,
      }),
    ).toMatchObject({ applicationAccess: false, canRenew: false });
    expect(
      toSubscriptionAccessView(EXPIRED, {
        isOwner: true,
        scope: AccessScope.APP,
      }),
    ).toMatchObject({ subscriptionState: 'expired', applicationAccess: false });
    expect(
      toSubscriptionAccessView(
        { ...EXPIRED, state: 'none', coverageEndsAt: null },
        { isOwner: false, scope: AccessScope.APP },
      ).coverageEndsAt,
    ).toBeNull();
  });
});

describe('HttpExceptionFilter — no-store des refus commerciaux (1-14C.1)', () => {
  function run(exception: ForbiddenException | ServiceUnavailableException) {
    const setHeader = jest.fn();
    const json = jest.fn();
    const response = { status: jest.fn(() => ({ json })), setHeader };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ url: '/auth/login' }),
      }),
    } as unknown as ArgumentsHost;
    new HttpExceptionFilter().catch(exception, host);
    return {
      setHeader,
      body: json.mock.calls[0][0] as Record<string, unknown>,
    };
  }

  it('SUBSCRIPTION_INACTIVE → no-store, champs structurés conservés', () => {
    const { setHeader, body } = run(
      subscriptionInactiveException({ restrictedToken: 't' }),
    );
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(body).toMatchObject({
      statusCode: 403,
      code: 'SUBSCRIPTION_INACTIVE',
      restrictedToken: 't',
    });
  });

  it('autres refus → en-têtes inchangés', () => {
    const { setHeader } = run(
      new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'x' }),
    );
    expect(setHeader).not.toHaveBeenCalled();
  });
});

describe('SubscriptionAccessGuard (1-14C.1)', () => {
  let subscriptions: { getAccessDecision: jest.Mock };
  let guard: SubscriptionAccessGuard;

  function context(
    request: Record<string, unknown>,
    handlerMeta: Record<string, unknown> = {},
    type = 'http',
  ): ExecutionContext {
    const handler = () => undefined;
    for (const [key, value] of Object.entries(handlerMeta)) {
      Reflect.defineMetadata(key, value, handler);
    }
    return {
      getType: () => type,
      getHandler: () => handler,
      getClass: () => class Fixture {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  const appRequest = (): Record<string, unknown> => ({
    user: { accessScope: AccessScope.APP },
    organizationContext: { organizationId: ORG_ID },
  });

  const codeOf = async (promise: Promise<unknown>) => {
    const error: unknown = await promise.catch((e: unknown) => e);
    return {
      error,
      code: ((error as ForbiddenException).getResponse() as { code?: string })
        .code,
    };
  };

  beforeEach(() => {
    subscriptions = { getAccessDecision: jest.fn().mockResolvedValue(ACTIVE) };
    guard = new SubscriptionAccessGuard(
      new Reflector(),
      subscriptions as never,
    );
  });

  it('non-HTTP et @Public : hors périmètre, aucune lecture', async () => {
    await expect(guard.canActivate(context({}, {}, 'ws'))).resolves.toBe(true);
    await expect(
      guard.canActivate(context({}, { [IS_PUBLIC_KEY]: true })),
    ).resolves.toBe(true);
    expect(subscriptions.getAccessDecision).not.toHaveBeenCalled();
  });

  it('exception identity : JWT limité accepté, aucune lecture du registre', async () => {
    const request = {
      user: { accessScope: AccessScope.SUBSCRIPTION_LIMITED },
    };
    await expect(
      guard.canActivate(
        context(request, { [SUBSCRIPTION_ACCESS_EXEMPTION_KEY]: 'identity' }),
      ),
    ).resolves.toBe(true);
    expect(subscriptions.getAccessDecision).not.toHaveBeenCalled();
  });

  it('route métier + abonnement actif → autorisé, décision branchée', async () => {
    const request = appRequest();
    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(subscriptions.getAccessDecision).toHaveBeenCalledWith(ORG_ID);
    expect(request.subscriptionAccess).toBe(ACTIVE);
  });

  it.each(['expired', 'none', 'scheduled'] as const)(
    'route métier + état %s → 403 SUBSCRIPTION_INACTIVE',
    async (state) => {
      subscriptions.getAccessDecision.mockResolvedValue({
        ...EXPIRED,
        state,
      });
      const { error, code } = await codeOf(
        guard.canActivate(context(appRequest())),
      );
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(code).toBe('SUBSCRIPTION_INACTIVE');
    },
  );

  it('JWT limité sur route métier → 403 SUBSCRIPTION_ACCESS_LIMITED, même abonnement actif', async () => {
    const request = {
      ...appRequest(),
      user: { accessScope: AccessScope.SUBSCRIPTION_LIMITED },
    };
    const { code } = await codeOf(guard.canActivate(context(request)));
    expect(code).toBe('SUBSCRIPTION_ACCESS_LIMITED');
    expect(subscriptions.getAccessDecision).not.toHaveBeenCalled();
  });

  it('principal incomplet ou sans portée → refus (fail-closed)', async () => {
    for (const request of [
      {},
      { user: {} },
      {
        user: { accessScope: 'unknown' },
        organizationContext: { organizationId: ORG_ID },
      },
    ]) {
      const { code } = await codeOf(guard.canActivate(context(request)));
      expect(code).toBe('SUBSCRIPTION_ACCESS_LIMITED');
    }
  });

  it('route sans contexte d’organisation et sans exception → refus', async () => {
    const { code } = await codeOf(
      guard.canActivate(context({ user: { accessScope: AccessScope.APP } })),
    );
    expect(code).toBe('SUBSCRIPTION_ACCESS_LIMITED');
  });

  it('sale-replay : JWT applicatif inactif → laissé au service (décision inactive branchée)', async () => {
    subscriptions.getAccessDecision.mockResolvedValue(EXPIRED);
    const request = appRequest();
    await expect(
      guard.canActivate(
        context(request, {
          [SUBSCRIPTION_ACCESS_EXEMPTION_KEY]: 'sale-replay',
        }),
      ),
    ).resolves.toBe(true);
    expect(request.subscriptionAccess).toBe(EXPIRED);
  });

  it('sale-replay : JWT limité → refusé', async () => {
    const { code } = await codeOf(
      guard.canActivate(
        context(
          {
            ...appRequest(),
            user: { accessScope: AccessScope.SUBSCRIPTION_LIMITED },
          },
          { [SUBSCRIPTION_ACCESS_EXEMPTION_KEY]: 'sale-replay' },
        ),
      ),
    );
    expect(code).toBe('SUBSCRIPTION_ACCESS_LIMITED');
  });

  it('lecture impossible → 503 SUBSCRIPTION_STATUS_UNAVAILABLE (jamais « expiré »)', async () => {
    subscriptions.getAccessDecision.mockRejectedValue(new Error('db down'));
    const { error, code } = await codeOf(
      guard.canActivate(context(appRequest())),
    );
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(code).toBe('SUBSCRIPTION_STATUS_UNAVAILABLE');
  });
});
