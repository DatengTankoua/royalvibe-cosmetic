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
import { computeRetryAfterSeconds } from '../common/auth-rate-limiting';

/**
 * 1-16C.1 — Limitation de `POST /support/requests`. Même infrastructure que
 * les invitations et les paiements : fenêtre nommée fusionnée dans l'UNIQUE
 * `ThrottlerModule.forRoot()` (`auth.module.ts`), stockage mémoire officiel
 * (une seule instance d'API ; stockage partagé obligatoire avant tout
 * déploiement horizontal). Les autres gardes throttler du projet s'en
 * excluent par `SKIP_SUPPORT_THROTTLER`.
 *
 * Tracker : utilisateur authentifié + organisation courante. Les gardes
 * globaux s'exécutent AVANT : un refus de session, d'organisation, d'accès
 * commercial ou de permission ne consomme jamais ce quota. Chaque requête
 * compte, rejeux compris.
 */
export const SUPPORT_REQUEST_THROTTLER = 'support-request';
export const SUPPORT_REQUEST_LIMIT = 5;
export const SUPPORT_REQUEST_TTL = seconds(600);
export const SUPPORT_REQUEST_BLOCK = seconds(600);

export const SUPPORT_RATE_LIMIT_CODE = 'SUPPORT_RATE_LIMITED';
export const SUPPORT_RATE_LIMIT_MESSAGE =
  "Trop de demandes d'assistance. Réessayez plus tard.";

export function createSupportThrottlerWindow(): ThrottlerOptions {
  return {
    name: SUPPORT_REQUEST_THROTTLER,
    limit: SUPPORT_REQUEST_LIMIT,
    ttl: SUPPORT_REQUEST_TTL,
    blockDuration: SUPPORT_REQUEST_BLOCK,
  };
}

/** Exclusion à poser par les AUTRES gardes throttler du projet. */
export const SKIP_SUPPORT_THROTTLER = Object.freeze({
  [SUPPORT_REQUEST_THROTTLER]: true,
});

@Injectable()
export class SupportRequestThrottlerGuard extends ThrottlerGuard {
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

  /** Clé non sensible : userId + organizationId uniquement. */
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
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: SUPPORT_RATE_LIMIT_CODE,
        message: SUPPORT_RATE_LIMIT_MESSAGE,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
