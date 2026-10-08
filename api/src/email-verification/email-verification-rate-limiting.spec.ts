import { ExecutionContext, HttpException } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import {
  EMAIL_VERIFICATION_ADDRESS_BLOCK,
  EMAIL_VERIFICATION_ADDRESS_LIMIT,
  EMAIL_VERIFICATION_ADDRESS_THROTTLER,
  EMAIL_VERIFICATION_ADDRESS_TTL,
  EmailVerificationAddressThrottlerGuard,
  emailVerificationAddressKey,
} from './email-verification-rate-limiting';

function makeContext(body: unknown) {
  const setHeader = jest.fn();
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ body }),
      getResponse: () => ({ setHeader }),
    }),
  } as unknown as ExecutionContext;
  return { context, setHeader };
}

describe('EmailVerificationAddressThrottlerGuard (1-13A)', () => {
  let increment: jest.Mock;
  let guard: EmailVerificationAddressThrottlerGuard;

  beforeEach(() => {
    increment = jest.fn().mockResolvedValue({
      totalHits: 1,
      timeToExpire: 900,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    const storage = { increment } as unknown as ThrottlerStorage;
    guard = new EmailVerificationAddressThrottlerGuard(storage);
  });

  it('clé = SHA-256 de l’adresse normalisée, jamais l’adresse en clair', async () => {
    const { context } = makeContext({ email: '  Ada@Example.com ' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    const [key, ttl, limit, block, name] = increment.mock.calls[0] as [
      string,
      number,
      number,
      number,
      string,
    ];
    expect(key).toBe(emailVerificationAddressKey('ada@example.com'));
    expect(key).not.toContain('ada');
    expect(key).toMatch(/^email-verification-address:[0-9a-f]{64}$/);
    expect([ttl, limit, block, name]).toEqual([
      EMAIL_VERIFICATION_ADDRESS_TTL,
      EMAIL_VERIFICATION_ADDRESS_LIMIT,
      EMAIL_VERIFICATION_ADDRESS_BLOCK,
      EMAIL_VERIFICATION_ADDRESS_THROTTLER,
    ]);
  });

  it('bloqué → 429 stable + Retry-After', async () => {
    increment.mockResolvedValue({
      totalHits: 6,
      timeToExpire: 900,
      isBlocked: true,
      timeToBlockExpire: 42,
    });
    const { context, setHeader } = makeContext({ email: 'ada@example.com' });
    const error: unknown = await guard
      .canActivate(context)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: 'EMAIL_VERIFICATION_RATE_LIMITED',
    });
    expect(
      JSON.stringify((error as HttpException).getResponse()),
    ).not.toContain('ada@');
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '42');
  });

  it.each([undefined, {}, { email: 42 }, { email: '  ' }])(
    'adresse absente/mal typée (%p) → laissée à la validation, aucun compteur',
    async (body) => {
      const { context } = makeContext(body);
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(increment).not.toHaveBeenCalled();
    },
  );
});
