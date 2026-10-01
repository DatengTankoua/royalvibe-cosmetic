import {
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type {
  ThrottlerLimitDetail,
  ThrottlerModuleOptions,
  ThrottlerOptions,
} from '@nestjs/throttler';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerStorage,
  seconds,
} from '@nestjs/throttler';
import { computeRetryAfterSeconds } from './auth-rate-limiting';

/**
 * 1-14D.2B — Limitation de débit des routes de paiement d'abonnement.
 *
 * Réutilise STRICTEMENT l'infrastructure existante : deux fenêtres nommées
 * fusionnées dans l'UNIQUE `ThrottlerModule.forRoot()` (`auth.module.ts`),
 * même stockage mémoire (mêmes limites documentées : une instance d'API ;
 * stockage partagé obligatoire avant tout déploiement horizontal).
 *
 * - `subscription-payment-write` : création et refresh (effets externes) ;
 * - `subscription-payment-read`  : lectures locales (sondage de l'UI).
 * Chaque route sélectionne SA fenêtre par `@SkipThrottle` explicite ; les
 * autres gardes du projet (`AuthThrottlerGuard`, invitations) s'en
 * excluent symétriquement.
 *
 * Tracker : utilisateur authentifié + organisation courante (gardes
 * globaux exécutés AVANT : un refus d'authentification, de contexte ou de
 * permission ne consomme jamais ce quota). Jamais l'IP, le téléphone ni un
 * jeton.
 */

export const PAYMENT_RATE_LIMIT_CODE = 'PAYMENT_RATE_LIMITED';
export const PAYMENT_RATE_LIMIT_MESSAGE =
  'Trop de demandes de paiement. Réessayez plus tard.';

export const PAYMENT_WRITE_THROTTLER = 'subscription-payment-write';
export const PAYMENT_WRITE_LIMIT = 10;
export const PAYMENT_WRITE_TTL = seconds(60);
export const PAYMENT_WRITE_BLOCK = seconds(60);

export const PAYMENT_READ_THROTTLER = 'subscription-payment-read';
export const PAYMENT_READ_LIMIT = 60;
export const PAYMENT_READ_TTL = seconds(60);
export const PAYMENT_READ_BLOCK = seconds(30);

export function createPaymentThrottlerWindows(): ThrottlerOptions[] {
  return [
    {
      name: PAYMENT_WRITE_THROTTLER,
      limit: PAYMENT_WRITE_LIMIT,
      ttl: PAYMENT_WRITE_TTL,
      blockDuration: PAYMENT_WRITE_BLOCK,
    },
    {
      name: PAYMENT_READ_THROTTLER,
      limit: PAYMENT_READ_LIMIT,
      ttl: PAYMENT_READ_TTL,
      blockDuration: PAYMENT_READ_BLOCK,
    },
  ];
}

/** Exclusions à poser par les AUTRES gardes throttler du projet. */
export const SKIP_PAYMENT_THROTTLERS = Object.freeze({
  [PAYMENT_WRITE_THROTTLER]: true,
  [PAYMENT_READ_THROTTLER]: true,
});

@Injectable()
export class SubscriptionPaymentThrottlerGuard extends ThrottlerGuard {
  private initialized = false;

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
  ) {
    super(options, storage, reflector);
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.initialized) {
      await this.onModuleInit();
      this.initialized = true;
    }
    return super.canActivate(context);
  }

  protected override getTracker(req: {
    user?: { _id?: { toString(): string } };
    organizationContext?: { organizationId?: string };
  }): Promise<string> {
    const userId = req.user?._id?.toString() ?? 'unknown-user';
    const organizationId =
      req.organizationContext?.organizationId ?? 'unknown-org';
    return Promise.resolve(`${userId}:${organizationId}`);
  }

  protected override throwThrottlingException(
    context: ExecutionContext,
    limitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    const { res } = this.getRequestResponse(context);
    const retryAfter = computeRetryAfterSeconds(
      limitDetail.timeToBlockExpire * 1000,
    );
    if (retryAfter !== undefined) {
      res.setHeader('Retry-After', String(retryAfter));
    }
    res.setHeader('Cache-Control', 'no-store');
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: PAYMENT_RATE_LIMIT_CODE,
        message: PAYMENT_RATE_LIMIT_MESSAGE,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
