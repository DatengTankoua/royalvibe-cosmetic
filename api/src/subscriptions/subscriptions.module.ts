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
  SUBSCRIPTION_MONOTONIC_CLOCK,
  systemMonotonicClock,
  systemSubscriptionClock,
} from './subscription-clock';
import {
  SubscriptionPayment,
  SubscriptionPaymentSchema,
} from './payments/schemas/subscription-payment.schema';
import { SubscriptionPaymentsService } from './payments/subscription-payments.service';
import { SubscriptionPaymentsController } from './payments/subscription-payments.controller';
import { SubscriptionPaymentIndexCheck } from './payments/subscription-payment-indexes';
import {
  PAYMENT_PROVIDER,
  UnavailablePaymentProvider,
} from './payments/payment-provider';
import { SubscriptionPaymentThrottlerGuard } from '../common/subscription-payment-rate-limiting';

/**
 * 1-14B — Importé par `OrganizationsModule` (essai attribué à la création).
 * N'importe PAS `OrganizationsModule` (aucune dépendance circulaire) :
 * enregistre seulement le modèle `Organization` pour vérifier son existence,
 * en lecture.
 *
 * 1-14D.2B — paiements d'abonnement : `PAYMENT_PROVIDER` vaut
 * `UnavailablePaymentProvider` (aucun réseau, 503) tant qu'aucun adaptateur
 * réel n'est branché ; seuls les tests le remplacent (`overrideProvider`).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SubscriptionPeriod.name, schema: SubscriptionPeriodSchema },
      { name: Organization.name, schema: OrganizationSchema },
      { name: SubscriptionPayment.name, schema: SubscriptionPaymentSchema },
    ]),
  ],
  controllers: [SubscriptionsController, SubscriptionPaymentsController],
  providers: [
    SubscriptionsService,
    SubscriptionPeriodIndexCheck,
    { provide: SUBSCRIPTION_CLOCK, useValue: systemSubscriptionClock },
    {
      provide: SUBSCRIPTION_MONOTONIC_CLOCK,
      useValue: systemMonotonicClock,
    },
    SubscriptionPaymentsService,
    SubscriptionPaymentIndexCheck,
    SubscriptionPaymentThrottlerGuard,
    { provide: PAYMENT_PROVIDER, useClass: UnavailablePaymentProvider },
  ],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
