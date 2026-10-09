import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PersistentRateLimiter } from './persistent-rate-limiter.service';

/** 1-18C — Plafonds persistants (comptes, destinataires d'invitation). */
@Module({
  imports: [ConfigModule],
  providers: [PersistentRateLimiter],
  exports: [PersistentRateLimiter],
})
export class RateLimitModule {}
