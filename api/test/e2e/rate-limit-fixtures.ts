import type { TestingModule } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { Connection } from 'mongoose';
import { RATE_LIMIT_BUCKETS_COLLECTION } from '../../src/common/rate-limit/persistent-rate-limiter.service';

/**
 * Isolation des tests de limitation : compteurs EN MÉMOIRE par IP
 * (`@nestjs/throttler`) ET compteurs PERSISTANTS 1-18C (par compte, par
 * destinataire), qui survivent sinon d'un test à l'autre dans la même base.
 */
export async function resetAuthRateLimits(
  moduleFixture: TestingModule,
): Promise<void> {
  moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  await moduleFixture
    .get<Connection>(getConnectionToken())
    .collection(RATE_LIMIT_BUCKETS_COLLECTION)
    .deleteMany({});
}
