import { Injectable } from '@nestjs/common';
import { InjectThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { NormalizedAddressThrottlerGuard } from '../email-verification/email-verification-rate-limiting';

/** Namespace distinct de la vérification d'email (compteurs séparés). */
export const PASSWORD_RESET_ADDRESS_THROTTLER = 'password-reset-address';
export const PASSWORD_RESET_RATE_LIMIT_CODE = 'PASSWORD_RESET_RATE_LIMITED';

/** 1-13B : 5 demandes / 15 min par adresse normalisée (clé hachée). */
@Injectable()
export class PasswordResetAddressThrottlerGuard extends NormalizedAddressThrottlerGuard {
  protected readonly namespace = PASSWORD_RESET_ADDRESS_THROTTLER;
  protected readonly rateLimitCode = PASSWORD_RESET_RATE_LIMIT_CODE;

  constructor(@InjectThrottlerStorage() storage: ThrottlerStorage) {
    super(storage);
  }
}
