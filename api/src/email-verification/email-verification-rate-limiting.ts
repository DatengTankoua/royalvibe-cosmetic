import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectThrottlerStorage, minutes } from '@nestjs/throttler';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { createHash } from 'crypto';
import {
  RateLimitedException,
  computeRetryAfterSeconds,
} from '../common/auth-rate-limiting';

/**
 * 1-13A — Limitation par ADRESSE normalisée de
 * `POST /auth/email-verification/request`, en complément de
 * `AuthThrottlerGuard` (par IP). Même stockage mémoire officiel de
 * `@nestjs/throttler` (même limite mono-instance que 0B.6/1-10B), sans
 * fenêtre globale supplémentaire : la clé est SHA-256(adresse), jamais
 * l'adresse en clair. Appliquée à toute adresse, existante ou non : un
 * refus ne révèle rien sur l'existence d'un compte.
 */
export const EMAIL_VERIFICATION_ADDRESS_THROTTLER =
  'email-verification-address';
export const EMAIL_VERIFICATION_ADDRESS_LIMIT = 5;
export const EMAIL_VERIFICATION_ADDRESS_TTL = minutes(15);
export const EMAIL_VERIFICATION_ADDRESS_BLOCK = minutes(15);

export const EMAIL_VERIFICATION_RATE_LIMIT_CODE =
  'EMAIL_VERIFICATION_RATE_LIMITED';

/** Clé hachée d'une adresse normalisée, préfixée par un namespace. */
export function hashedAddressKey(namespace: string, email: string): string {
  const digest = createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex');
  return `${namespace}:${digest}`;
}

export function emailVerificationAddressKey(email: string): string {
  return hashedAddressKey(EMAIL_VERIFICATION_ADDRESS_THROTTLER, email);
}

/**
 * Base commune (1-13A, réutilisée en 1-13B) : 5 demandes / 15 min par
 * adresse normalisée, blocage 15 min, clé `namespace:SHA-256(adresse)`.
 *
 * 1-18D — Service (et non plus garde) : appelé dans le gestionnaire APRÈS
 * la validation du corps et la vérification Turnstile, pour qu'une demande
 * sans défi valide ne consomme jamais le quota d'une adresse. Même stockage,
 * mêmes seuils, même réponse 429 (avec `Retry-After`).
 */
@Injectable()
export class AddressRequestLimiter {
  constructor(
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
  ) {}

  async consume(
    namespace: string,
    rateLimitCode: string,
    email: string,
  ): Promise<void> {
    const record = await this.storage.increment(
      hashedAddressKey(namespace, email),
      EMAIL_VERIFICATION_ADDRESS_TTL,
      EMAIL_VERIFICATION_ADDRESS_LIMIT,
      EMAIL_VERIFICATION_ADDRESS_BLOCK,
      namespace,
    );
    if (!record.isBlocked) return;
    throw new RateLimitedException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: rateLimitCode,
        message: 'Trop de demandes. Réessayez plus tard.',
      },
      computeRetryAfterSeconds(record.timeToBlockExpire * 1000) ?? 1,
    );
  }
}
