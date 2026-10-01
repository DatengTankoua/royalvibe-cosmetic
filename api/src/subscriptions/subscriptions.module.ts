import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  SubscriptionPeriod,
  SubscriptionPeriodSchema,
} from './schemas/subscription-period.schema';
import {
  Organization,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionPeriodIndexCheck } from './subscription-period-indexes';
import {
  SUBSCRIPTION_CLOCK,
  systemSubscriptionClock,
} from './subscription-clock';

/**
 * 1-14B — Importé par `OrganizationsModule` (essai attribué à la création).
 * N'importe PAS `OrganizationsModule` (aucune dépendance circulaire) :
 * enregistre seulement le modèle `Organization` pour vérifier son existence,
 * en lecture.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SubscriptionPeriod.name, schema: SubscriptionPeriodSchema },
      { name: Organization.name, schema: OrganizationSchema },
    ]),
  ],
  controllers: [SubscriptionsController],
  providers: [
    SubscriptionsService,
    SubscriptionPeriodIndexCheck,
    { provide: SUBSCRIPTION_CLOCK, useValue: systemSubscriptionClock },
  ],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
