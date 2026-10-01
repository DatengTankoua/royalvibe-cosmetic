import { Controller, Get, Header } from '@nestjs/common';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import { OwnerOnly } from '../auth/decorators/permissions.decorator';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { SubscriptionsService } from './subscriptions.service';
import { AllowInactiveSubscription } from './subscription-access';

/**
 * 1-14B — Lecture SEULE de l'état d'abonnement de l'organisation COURANTE
 * (contexte branché par `OrganizationGuard`, jamais body/query/params).
 *
 * Réservée au propriétaire : opération owner-only `billing.identity`
 * (`PermissionGuard` exige `role === owner`, jamais délégable, jamais
 * `User.role`). Aucune route d'écriture : l'activation passe uniquement par
 * le script serveur.
 *
 * Projection explicite : état, période courante, dates utiles et (1-14C.2)
 * historique des périodes. Jamais de référence, d'opérateur, de source,
 * d'identifiant de période ni de rang interne.
 */
@Controller('organizations/current/subscription')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  // 1-14C.1 : parcours de renouvellement — lisible avec un abonnement
  // inactif et/ou un jeton limité, TOUJOURS réservé au propriétaire réel
  // (`PermissionGuard`). N'ouvre ni branding, ni membres, ni données métier.
  @Get()
  @Header('Cache-Control', 'no-store')
  @AllowInactiveSubscription('identity')
  @OwnerOnly('billing.identity')
  async current(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const { view, periods } =
      await this.subscriptionsService.getStateWithHistory(
        organizationContext.organizationId,
      );
    return {
      state: view.state,
      currentPeriod: view.currentPeriod
        ? {
            kind: view.currentPeriod.kind,
            term: view.currentPeriod.term,
            startsAt: view.currentPeriod.startsAt.toISOString(),
            endsAt: view.currentPeriod.endsAt.toISOString(),
          }
        : null,
      coverageEndsAt: view.coverageEndsAt?.toISOString() ?? null,
      nextPeriodStartsAt: view.nextPeriodStartsAt?.toISOString() ?? null,
      // 1-14C.2 : historique des PÉRIODES (pas des paiements), projection
      // explicite, de la plus récente à la plus ancienne.
      periods: periods.map((p) => ({
        kind: p.kind,
        term: p.term,
        startsAt: p.startsAt.toISOString(),
        endsAt: p.endsAt.toISOString(),
      })),
    };
  }
}
