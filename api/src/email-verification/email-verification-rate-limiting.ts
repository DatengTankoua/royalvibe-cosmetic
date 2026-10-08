import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { InjectThrottlerStorage, minutes } from '@nestjs/throttler';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { createHash } from 'crypto';
import { computeRetryAfterSeconds } from '../common/auth-rate-limiting';

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
 */
export abstract class NormalizedAddressThrottlerGuard implements CanActivate {
  protected abstract readonly namespace: string;
  protected abstract readonly rateLimitCode: string;

  constructor(private readonly storage: ThrottlerStorage) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const body = http.getRequest<Request>().body as
      { email?: unknown } | undefined;
    // Adresse absente/mal typée : laissée à la validation (400), pas de clé.
    if (typeof body?.email !== 'string' || body.email.trim() === '') {
      return true;
    }
    const record = await this.storage.increment(
      hashedAddressKey(this.namespace, body.email),
      EMAIL_VERIFICATION_ADDRESS_TTL,
      EMAIL_VERIFICATION_ADDRESS_LIMIT,
      EMAIL_VERIFICATION_ADDRESS_BLOCK,
      this.namespace,
    );
    if (!record.isBlocked) return true;

    const retryAfter = computeRetryAfterSeconds(
      record.timeToBlockExpire * 1000,
    );
    if (retryAfter !== undefined) {
      http.getResponse<Response>().setHeader('Retry-After', String(retryAfter));
    }
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: this.rateLimitCode,
        message: 'Trop de demandes. Réessayez plus tard.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

@Injectable()
export class EmailVerificationAddressThrottlerGuard extends NormalizedAddressThrottlerGuard {
  protected readonly namespace = EMAIL_VERIFICATION_ADDRESS_THROTTLER;
  protected readonly rateLimitCode = EMAIL_VERIFICATION_RATE_LIMIT_CODE;

  constructor(@InjectThrottlerStorage() storage: ThrottlerStorage) {
    super(storage);
  }
}
