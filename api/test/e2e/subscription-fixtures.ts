import type { TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { Organization } from '../../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from '../../src/organizations/schemas/organization.schema';
import { ensureSubscriptionPeriodIndexes } from '../../src/subscriptions/subscription-period-indexes';
import { SubscriptionsService } from '../../src/subscriptions/subscriptions.service';

/**
 * 1-14C.1 — Fixture E2E : les organisations de test qui ont besoin d'un
 * accès métier reçoivent EXPLICITEMENT une période active, via le service
 * réel d'attribution (aucun bypass de production, aucun `NODE_ENV=test`).
 *
 * - crée d'abord les index requis (migration, comme en production) ;
 * - organisations ciblées (toutes par défaut) : si l'abonnement n'est pas
 *   actif à l'heure du service, attribue une période annuelle de référence
 *   déterministe `e2e-fixture:<organizationId>` (idempotente) ;
 * - les organisations inscrites via `/auth/register` ont déjà leur essai
 *   actif : elles sont laissées intactes.
 */
export async function activateTestSubscriptions(
  moduleFixture: TestingModule,
  organizationIds?: readonly string[],
): Promise<void> {
  const connection = moduleFixture.get<Connection>(getConnectionToken());
  await ensureSubscriptionPeriodIndexes(connection);
  const subscriptions = moduleFixture.get(SubscriptionsService);
  const ids =
    organizationIds ??
    (
      await moduleFixture
        .get<Model<OrganizationDocument>>(getModelToken(Organization.name))
        .find()
        .select({ _id: 1 })
        .lean()
        .exec()
    ).map((organization) => String(organization._id));
  for (const organizationId of ids) {
    const decision = await subscriptions.getAccessDecision(organizationId);
    if (decision.active) continue;
    await subscriptions.grantSubscription({
      organizationId,
      term: 'annual',
      sourceReference: `e2e-fixture:${organizationId}`,
      grantedBy: 'e2e-fixture',
    });
  }
}
