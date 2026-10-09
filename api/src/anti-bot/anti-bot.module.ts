import { Module } from '@nestjs/common';
import { TurnstileService } from './turnstile.service';

/** 1-18C — Vérification anti-robot (Cloudflare Turnstile ou simulation locale). */
@Module({
  providers: [TurnstileService],
  exports: [TurnstileService],
})
export class AntiBotModule {}
