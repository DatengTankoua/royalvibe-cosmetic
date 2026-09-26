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
 * Rate limiting de POST /organizations/invitations (correction sécurité
 * 1-10B) — RÉUTILISE STRICTEMENT l'infrastructure `@nestjs/throttler` déjà
 * en place (0B.6) : cette fenêtre nommée est fusionnée dans l'UNIQUE
 * `ThrottlerModule.forRoot()` du projet (`auth.module.ts`), donc le MÊME
 * stockage mémoire officiel que `login-short`/`login-long`. Aucun package
 * ajouté, aucune seconde instance de stockage créée.
 *
 * Stockage mémoire : correct pour UNE SEULE instance d'API (pilote) ; les
 * compteurs sont perdus au redémarrage et NE SONT PAS partagés entre
 * instances si l'API est répliquée. Un stockage partagé (Redis, via
 * `ThrottlerModuleOptions.storage`) est OBLIGATOIRE avant tout déploiement
 * horizontal — même limite déjà documentée pour le login (0B.6).
 */

/** Code stable renvoyé lorsque la création d'invitations est trop fréquente. */
export const INVITATION_RATE_LIMIT_CODE = 'INVITATION_RATE_LIMITED';
/** Message stable — aucune donnée d'invitation (email/rôle/token) ni compteur. */
export const INVITATION_RATE_LIMIT_MESSAGE =
  "Trop de créations d'invitations. Réessayez plus tard.";

/**
 * Corps STABLE — même CONTRAT que `buildAuthRateLimitBody()` (mêmes 3 champs,
 * même sémantique de `Retry-After`), code/message distincts car l'action
 * n'est pas une connexion.
 */
export function buildInvitationRateLimitBody(): {
  statusCode: number;
  code: string;
  message: string;
} {
  return {
    statusCode: HttpStatus.TOO_MANY_REQUESTS,
    code: INVITATION_RATE_LIMIT_CODE,
    message: INVITATION_RATE_LIMIT_MESSAGE,
  };
}

/** Fenêtre courte et raisonnable (5 créations / 60 s, blocage 60 s). */
export const INVITATION_CREATE_NAME = 'invitation-create';
export const INVITATION_CREATE_LIMIT = 5;
export const INVITATION_CREATE_TTL = seconds(60);
export const INVITATION_CREATE_BLOCK = seconds(60);

/**
 * Fenêtre nommée à fusionner dans les `throttlers` du SEUL
 * `ThrottlerModule.forRoot()` du projet (jamais un second `forRoot()` —
 * `ThrottlerModule` est `@Global()`, une seconde instance créerait un
 * stockage ambigu pour les tokens globaux `ThrottlerStorage`/options).
 */
export function createInvitationThrottlerWindow(): ThrottlerOptions {
  return {
    name: INVITATION_CREATE_NAME,
    limit: INVITATION_CREATE_LIMIT,
    ttl: INVITATION_CREATE_TTL,
    blockDuration: INVITATION_CREATE_BLOCK,
  };
}

/**
 * Garde à joindre UNIQUEMENT à `POST /organizations/invitations` (jamais
 * `GET`/`revoke`, jamais garde globale). `AuthThrottlerGuard` trace par IP
 * car conçu pour des routes PUBLIQUES (login/register) — cette route est
 * déjà authentifiée ET tenant-scopée par les gardes globaux qui s'exécutent
 * AVANT toute garde de méthode (`JwtAuthGuard`→`OrganizationGuard`→
 * `PermissionGuard`→`RolesGuard`, ordre fixé dans `auth.module.ts`) : au
 * moment où CE garde s'exécute, `request.user` et `request.organizationContext`
 * sont déjà branchés, donc le tracker combine utilisateur authentifié ET
 * organisation courante — JAMAIS l'IP, JAMAIS l'email/le token/une clé API.
 * Conséquence directe de cet ordre : un refus `PermissionGuard` (403) ou
 * `OrganizationGuard` empêche ce garde de s'exécuter DU TOUT — un acteur
 * sans `members.invite` ne peut jamais consommer/épuiser ce quota.
 */
@Injectable()
export class InvitationCreateThrottlerGuard extends ThrottlerGuard {
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

  /** Composition NON sensible de la clé : userId + organizationId uniquement. */
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
      buildInvitationRateLimitBody(),
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
