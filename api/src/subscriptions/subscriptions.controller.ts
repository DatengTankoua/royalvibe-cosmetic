import { Controller, Get } from '@nestjs/common';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import { OwnerOnly } from '../auth/decorators/permissions.decorator';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { SubscriptionsService } from './subscriptions.service';

/**
 * 1-14B — Lecture SEULE de l'état d'abonnement de l'organisation COURANTE
 * (contexte branché par `OrganizationGuard`, jamais body/query/params).
 *
 * Réservée au propriétaire : opération owner-only `billing.identity`
 * (`PermissionGuard` exige `role === owner`, jamais délégable, jamais
 * `User.role`). Aucune route d'écriture : l'activation passe uniquement par
 * le script serveur.
 *
 * Projection explicite : état, période courante, dates utiles. Jamais de
 * référence, d'opérateur, d'identifiant de période ni de rang interne.
 */
@Controller('organizations/current/subscription')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Get()
  @OwnerOnly('billing.identity')
  async current(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const view = await this.subscriptionsService.getState(
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
    };
  }
}
