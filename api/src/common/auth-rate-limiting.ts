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
} from '@nestjs/throttler';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerStorage,
  minutes,
  seconds,
} from '@nestjs/throttler';

/**
 * Rate limiting de POST /auth/login (phase 0B.6).
 *
 * Le stockage reste le stockage mémoire OFFICIEL de `@nestjs/throttler` :
 * correct pour UNE SEULE instance d'API ; les compteurs sont perdus au
 * redémarrage et chaque instance aurait ses propres compteurs. Un stockage
 * partagé (Redis) est OBLIGATOIRE avant tout déploiement horizontal.
 * Ce module ne fournit PAS une limitation distribuée.
 *
 * Les deux fenêtres nommées sont appliquées UNIQUEMENT à `POST /auth/login`
 * (le garde est attaché à la méthode, jamais en garde globale de l'API).
 * Les helpers temporels officiels (`seconds`/`minutes`) sont utilisés.
 */

/** Code stable renvoyé lorsque la limite est dépassée. */
export const AUTH_RATE_LIMIT_CODE = 'AUTH_RATE_LIMITED';
/** Message stable (aucune donnée d'authentification, d'e-mail ni de compteur). */
export const AUTH_RATE_LIMIT_MESSAGE =
  'Trop de tentatives de connexion. Réessayez plus tard.';

/**
 * Corps STABLE de la réponse de limitation. Uniquement ces trois champs
 * stables : aucun mot de passe, aucun token, aucun e-mail, aucun compteur
 * de tentatives. Le reste du corps (error/path/timestamp) est ajouté par le
 * filtre d'exception global existant (comportement identique à tout 4xx/5xx).
 */
export function buildAuthRateLimitBody(): {
  statusCode: number;
  code: string;
  message: string;
} {
  return {
    statusCode: HttpStatus.TOO_MANY_REQUESTS,
    code: AUTH_RATE_LIMIT_CODE,
    message: AUTH_RATE_LIMIT_MESSAGE,
  };
}

/**
 * `Retry-After` en secondes : entier strictement positif, cohérent avec la
 * durée de blocage restante (plafonné, jamais 0 ni négatif). `undefined` si
 * la durée est absente/nulle — dans ce cas l'en-tête n'est pas émis.
 */
export function computeRetryAfterSeconds(
  blockDurationMs: number,
): number | undefined {
  if (!Number.isFinite(blockDurationMs)) {
    return undefined;
  }
  const secondsValue = Math.ceil(blockDurationMs / 1000);
  return secondsValue > 0 ? secondsValue : undefined;
}

/** Nom de la fenêtre courte (10 req / 60 s, blocage 60 s). */
export const LOGIN_SHORT_NAME = 'login-short';
/** Nom de la fenêtre longue (30 req / 15 min, blocage 15 min). */
export const LOGIN_LONG_NAME = 'login-long';

export const LOGIN_SHORT_LIMIT = 10;
export const LOGIN_SHORT_TTL = seconds(60);
export const LOGIN_SHORT_BLOCK = seconds(60);

export const LOGIN_LONG_LIMIT = 30;
export const LOGIN_LONG_TTL = minutes(15);
export const LOGIN_LONG_BLOCK = minutes(15);

/**
 * Options officielles de `@nestjs/throttler` : deux fenêtres nommées pour
 * le login. `setHeaders: false` supprime les en-têtes d'automate
 * `X-RateLimit-Remaining-*` (qui révéleraient le nombre exact de tentatives
 * restantes) et le `Retry-After` suffixed ; le garde ci-dessous émet un
 * `Retry-After` propre et le corps stable.
 */
export function createAuthThrottlerOptions(): ThrottlerModuleOptions {
  return {
    setHeaders: false,
    throttlers: [
      {
        name: LOGIN_SHORT_NAME,
        limit: LOGIN_SHORT_LIMIT,
        ttl: LOGIN_SHORT_TTL,
        blockDuration: LOGIN_SHORT_BLOCK,
      },
      {
        name: LOGIN_LONG_NAME,
        limit: LOGIN_LONG_LIMIT,
        ttl: LOGIN_LONG_TTL,
        blockDuration: LOGIN_LONG_BLOCK,
      },
    ],
  };
}

/**
 * Garde à joindre UNIQUEMENT à la méthode `login` (jamais en garde globale) :
 * renvoie le corps stable `{ code, statusCode, message }` avec HTTP 429 et un
 * en-tête `Retry-After` en secondes entières strictement positives, sans jamais
 * exposer de mot de passe, de token, d'e-mail ni de compteur.
 *
 * Le constructeur injecte explicitement les options et le stockage (tokens du
 * `@nestjs/throttler`). `canActivate` s'arme de façon paresseuse (`onModuleInit`
 * idempotent) : les fenêtres sont armées au besoin, sans dépendre de l'ordre
 * des hooks de cycle de vie du conteneur.
 */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
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
      buildAuthRateLimitBody(),
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * Parsing strict de `TRUST_PROXY_HOPS` (politique reverse proxy, 0B.6).
 * - absente / vide / `0` → `0` (aucun proxy approuvé : on ne se fie PAS à
 *   `X-Forwarded-For`) ;
 * - entier strictement positif → ce nombre exact de proxys approuvés ;
 * - négatif, décimal, texte ou valeur ambiguë → erreur claire au démarrage.
 * Aucun défaut n'est deviné pour la production.
 */
export function resolveTrustProxyHops(raw: string | undefined): number {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '' || trimmed === '0') {
    return 0;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `TRUST_PROXY_HOPS must be a non-negative integer (received: "${raw}").`,
    );
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `TRUST_PROXY_HOPS exceeds the safe integer range (received: "${raw}").`,
    );
  }
  return value;
}
