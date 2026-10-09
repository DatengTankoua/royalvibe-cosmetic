import type { ThrottlerStorage } from '@nestjs/throttler';
import {
  AddressRequestLimiter,
  EMAIL_VERIFICATION_ADDRESS_BLOCK,
  EMAIL_VERIFICATION_ADDRESS_LIMIT,
  EMAIL_VERIFICATION_ADDRESS_THROTTLER,
  EMAIL_VERIFICATION_ADDRESS_TTL,
  EMAIL_VERIFICATION_RATE_LIMIT_CODE,
  emailVerificationAddressKey,
} from './email-verification-rate-limiting';
import { RateLimitedException } from '../common/auth-rate-limiting';
import {
  PASSWORD_RESET_ADDRESS_THROTTLER,
  PASSWORD_RESET_RATE_LIMIT_CODE,
} from '../password-reset/password-reset-rate-limiting';

describe('AddressRequestLimiter (1-13A, service depuis 1-18D)', () => {
  let increment: jest.Mock;
  let limiter: AddressRequestLimiter;

  beforeEach(() => {
    increment = jest.fn().mockResolvedValue({
      totalHits: 1,
      timeToExpire: 900,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    const storage: ThrottlerStorage = { increment };
    limiter = new AddressRequestLimiter(storage);
  });

  it('clé = SHA-256 de l’adresse normalisée, jamais l’adresse en clair', async () => {
    await limiter.consume(
      EMAIL_VERIFICATION_ADDRESS_THROTTLER,
      EMAIL_VERIFICATION_RATE_LIMIT_CODE,
      '  Ada@Example.com ',
    );
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

  it('bloqué → 429 stable + Retry-After (via le filtre global)', async () => {
    increment.mockResolvedValue({
      totalHits: 6,
      timeToExpire: 900,
      isBlocked: true,
      timeToBlockExpire: 42,
    });
    const error: unknown = await limiter
      .consume(
        PASSWORD_RESET_ADDRESS_THROTTLER,
        PASSWORD_RESET_RATE_LIMIT_CODE,
        'ada@example.com',
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedException);
    expect((error as RateLimitedException).getStatus()).toBe(429);
    expect((error as RateLimitedException).getResponse()).toEqual({
      statusCode: 429,
      code: 'PASSWORD_RESET_RATE_LIMITED',
      message: 'Trop de demandes. Réessayez plus tard.',
    });
    expect((error as RateLimitedException).retryAfterSeconds).toBe(42);
    expect(
      JSON.stringify((error as RateLimitedException).getResponse()),
    ).not.toContain('ada@');
  });

  it('namespaces distincts : vérification et réinitialisation ne partagent pas leurs compteurs', async () => {
    await limiter.consume(
      EMAIL_VERIFICATION_ADDRESS_THROTTLER,
      EMAIL_VERIFICATION_RATE_LIMIT_CODE,
      'a@b.co',
    );
    await limiter.consume(
      PASSWORD_RESET_ADDRESS_THROTTLER,
      PASSWORD_RESET_RATE_LIMIT_CODE,
      'a@b.co',
    );
    const keys = increment.mock.calls.map((call) => call[0] as string);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
