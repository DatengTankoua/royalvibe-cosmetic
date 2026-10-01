/**
 * 1-14C.1 — Garde commerciale globale (refus PAR DÉFAUT).
 *
 * Position : APRÈS `OrganizationGuard` (suspension administrative,
 * membership révoquée et 403 uniforme restent prioritaires), AVANT
 * `PermissionGuard` (le blocage commercial est identique pour tous les
 * membres, sans révéler leurs permissions).
 *
 * - Non-HTTP et `@Public()` : hors périmètre (Socket.IO a son propre
 *   contrôle au handshake).
 * - `@AllowInactiveSubscription('identity')` : identification et état
 *   d'accès, JWT applicatif ou limité. Aucune lecture du registre ici.
 * - Toute autre route exige un JWT applicatif (`accessScope = app`, sinon
 *   403 `SUBSCRIPTION_ACCESS_LIMITED`) ET un abonnement `active` à l'heure
 *   serveur (sinon 403 `SUBSCRIPTION_INACTIVE`) ;
 *   `@AllowInactiveSubscription('sale-replay')` laisse passer un JWT
 *   applicatif inactif : le service n'autorise alors QUE la confirmation
 *   d'une vente déjà appliquée.
 * - Lecture impossible du registre : 503 `SUBSCRIPTION_STATUS_UNAVAILABLE`
 *   (accès refusé, jamais présenté comme une expiration).
 * - La décision est branchée en lecture seule sur
 *   `request.subscriptionAccess` ; aucune donnée client n'est lue.
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthenticatedPrincipal } from '../strategies/jwt.strategy';
import { ResolvedOrganizationContext } from '../../organizations/organizations.service';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import {
  AccessScope,
  SUBSCRIPTION_ACCESS_EXEMPTION_KEY,
  SubscriptionAccessDecision,
  SubscriptionAccessExemption,
  subscriptionAccessLimitedException,
  subscriptionInactiveException,
  subscriptionStatusUnavailableException,
} from '../../subscriptions/subscription-access';

export type SubscriptionAccessRequest = Request & {
  user?: AuthenticatedPrincipal;
  organizationContext?: ResolvedOrganizationContext;
  subscriptionAccess?: SubscriptionAccessDecision;
};

@Injectable()
export class SubscriptionAccessGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private subscriptionsService: SubscriptionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const exemption = this.reflector.getAllAndOverride<
      SubscriptionAccessExemption | undefined
    >(SUBSCRIPTION_ACCESS_EXEMPTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exemption === 'identity') return true;

    const request = context
      .switchToHttp()
      .getRequest<SubscriptionAccessRequest>();
    // Refus par défaut : portée autre que `app` (ou principal incomplet),
    // ou route sans contexte d'organisation non explicitement exemptée.
    if (request.user?.accessScope !== AccessScope.APP) {
      throw subscriptionAccessLimitedException();
    }
    const organizationId = request.organizationContext?.organizationId;
    if (!organizationId) {
      throw subscriptionAccessLimitedException();
    }

    let decision: SubscriptionAccessDecision;
    try {
      decision =
        await this.subscriptionsService.getAccessDecision(organizationId);
    } catch {
      throw subscriptionStatusUnavailableException();
    }
    request.subscriptionAccess = decision;

    if (decision.active) return true;
    if (exemption === 'sale-replay') return true;
    throw subscriptionInactiveException();
  }
}
