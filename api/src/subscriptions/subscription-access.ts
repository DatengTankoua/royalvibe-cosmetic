import {
  ExecutionContext,
  ForbiddenException,
  ServiceUnavailableException,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import type { SubscriptionStateName } from './subscription-terms';

/**
 * 1-14C.1 — Contrôle commercial de l'accès applicatif.
 *
 * Deux portées de JWT, portées par le claim SIGNÉ `accessScope` :
 * - `app` : accès applicatif, soumis au contrôle commercial à chaque
 *   requête (une expiration bloque aussi les sessions déjà ouvertes) ;
 * - `subscription_limited` : identification limitée (15 min), émise quand
 *   l'abonnement est inactif ; JAMAIS d'accès métier, même après
 *   activation — seul l'échange `POST /auth/subscription-access/complete`
 *   délivre un JWT applicatif.
 * Claim absent (JWT antérieur à 1-14C.1) : `app`, contrôle commercial
 * compris. Claim présent mais inconnu ou mal typé : refus, aucune
 * conversion.
 */
export const ACCESS_SCOPE_CLAIM = 'accessScope';

export enum AccessScope {
  APP = 'app',
  SUBSCRIPTION_LIMITED = 'subscription_limited',
}

/** Durée du jeton limité (identification, lecture du blocage, reprise). */
export const RESTRICTED_TOKEN_TTL_SECONDS = 15 * 60;

/** Portée lue dans un payload VÉRIFIÉ ; `null` si présente mais invalide. */
export function accessScopeFromClaims(
  payload: Readonly<Record<string, unknown>> | null | undefined,
): AccessScope | null {
  if (!payload || !(ACCESS_SCOPE_CLAIM in payload)) return AccessScope.APP;
  const value = payload[ACCESS_SCOPE_CLAIM];
  return value === AccessScope.APP || value === AccessScope.SUBSCRIPTION_LIMITED
    ? value
    : null;
}

// ─── Codes et réponses ───────────────────────────────────────────────────────

export const SUBSCRIPTION_INACTIVE = 'SUBSCRIPTION_INACTIVE';
export const SUBSCRIPTION_INACTIVE_MESSAGE =
  "L'abonnement de ce commerce n'est pas actif.";

export const SUBSCRIPTION_ACCESS_LIMITED = 'SUBSCRIPTION_ACCESS_LIMITED';
export const SUBSCRIPTION_ACCESS_LIMITED_MESSAGE =
  'Session limitée : accès au commerce indisponible.';

export const SUBSCRIPTION_STATUS_UNAVAILABLE =
  'SUBSCRIPTION_STATUS_UNAVAILABLE';
export const SUBSCRIPTION_STATUS_UNAVAILABLE_MESSAGE =
  "Impossible de vérifier l'abonnement pour le moment. Réessayez.";

/** Codes dont la réponse d'erreur porte `Cache-Control: no-store`. */
export const NO_STORE_ERROR_CODES: ReadonlySet<string> = new Set([
  SUBSCRIPTION_INACTIVE,
  SUBSCRIPTION_ACCESS_LIMITED,
  SUBSCRIPTION_STATUS_UNAVAILABLE,
]);

/** Projection d'accès exposée au client : jamais de champ du registre. */
export interface SubscriptionAccessView {
  subscriptionState: SubscriptionStateName;
  applicationAccess: boolean;
  coverageEndsAt: string | null;
  checkedAt: string;
  canRenew: boolean;
}

export function subscriptionInactiveException(
  extra: Record<string, unknown> = {},
): ForbiddenException {
  return new ForbiddenException({
    code: SUBSCRIPTION_INACTIVE,
    message: SUBSCRIPTION_INACTIVE_MESSAGE,
    ...extra,
  });
}

export function subscriptionAccessLimitedException(): ForbiddenException {
  return new ForbiddenException({
    code: SUBSCRIPTION_ACCESS_LIMITED,
    message: SUBSCRIPTION_ACCESS_LIMITED_MESSAGE,
  });
}

/** Échec technique de lecture : accès refusé, jamais présenté comme une expiration. */
export function subscriptionStatusUnavailableException(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: SUBSCRIPTION_STATUS_UNAVAILABLE,
    message: SUBSCRIPTION_STATUS_UNAVAILABLE_MESSAGE,
  });
}

// ─── Exceptions explicites par handler ───────────────────────────────────────

/**
 * Exceptions ÉTROITES au refus par défaut de `SubscriptionAccessGuard` :
 * - `identity` : identification et état d'accès (JWT applicatif OU limité,
 *   abonnement actif ou non) — le handler reste responsable de ce qu'il
 *   expose et des portées qu'il accepte ;
 * - `sale-replay` : `POST /sales` uniquement — JWT applicatif seul ; si
 *   l'abonnement est inactif, le service n'autorise QUE la confirmation
 *   d'une opération déjà appliquée (aucune écriture).
 */
export type SubscriptionAccessExemption = 'identity' | 'sale-replay';

export const SUBSCRIPTION_ACCESS_EXEMPTION_KEY = 'subscriptionAccessExemption';

export const AllowInactiveSubscription = (
  exemption: SubscriptionAccessExemption,
) => SetMetadata(SUBSCRIPTION_ACCESS_EXEMPTION_KEY, exemption);

/** Décision attachée à la requête par le guard (lecture seule). */
export interface SubscriptionAccessDecision {
  state: SubscriptionStateName;
  active: boolean;
  coverageEndsAt: Date | null;
  checkedAt: Date;
}

/** Décision branchée par `SubscriptionAccessGuard` (undefined si absente). */
export const CurrentSubscriptionAccess = createParamDecorator(
  (
    _data: unknown,
    ctx: ExecutionContext,
  ): SubscriptionAccessDecision | undefined =>
    ctx
      .switchToHttp()
      .getRequest<{ subscriptionAccess?: SubscriptionAccessDecision }>()
      .subscriptionAccess,
);

/**
 * Projection client. `applicationAccess` exige un JWT applicatif ET un
 * abonnement actif ; `canRenew` dérive du rôle RÉEL de la membership
 * (`owner`), jamais d'une permission déléguée ni de `User.role`.
 */
export function toSubscriptionAccessView(
  decision: SubscriptionAccessDecision,
  options: { isOwner: boolean; scope: AccessScope },
): SubscriptionAccessView {
  return {
    subscriptionState: decision.state,
    applicationAccess: options.scope === AccessScope.APP && decision.active,
    coverageEndsAt: decision.coverageEndsAt?.toISOString() ?? null,
    checkedAt: decision.checkedAt.toISOString(),
    canRenew: options.isOwner,
  };
}
