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
import {
  OrganizationMembership,
  OrganizationMembershipSchema,
} from '../organizations/schemas/membership.schema';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionPeriodIndexCheck } from './subscription-period-indexes';
import { SubscriptionSignalsService } from './subscription-signals.service';
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
  SubscriptionPaymentReconciliation,
  SubscriptionPaymentReconciliationSchema,
} from './payments/reconciliation/subscription-payment-reconciliation.schema';
import { PaymentReconciliationService } from './payments/reconciliation/payment-reconciliation.service';
import {
  PAYMENT_PROVIDER,
  UnavailablePaymentProvider,
} from './payments/payment-provider';
import {
  PaymentWebhookThrottlerGuard,
  SubscriptionPaymentThrottlerGuard,
} from '../common/subscription-payment-rate-limiting';
import { CamPayWebhookController } from './payments/campay/campay-webhook.controller';
import { CamPayWebhookService } from './payments/campay/campay-webhook.service';
import {
  CAMPAY_WEBHOOK_CONFIG,
  DISABLED_CAMPAY_WEBHOOK,
} from './payments/campay/campay-webhook.config';
import { PushModule } from '../push/push.module';

/**
 * 1-14B — Importé par `OrganizationsModule` (essai attribué à la création).
 * N'importe PAS `OrganizationsModule` (aucune dépendance circulaire) :
 * enregistre seulement le modèle `Organization` pour vérifier son existence,
 * en lecture.
 *
 * 1-14D.2B — paiements d'abonnement : `PAYMENT_PROVIDER` vaut
 * `UnavailablePaymentProvider` (aucun réseau, 503) tant qu'aucun adaptateur
 * réel n'est branché ; seuls les tests le remplacent (`overrideProvider`).
 *
 * 1-14D.2F — webhook CamPay : `CAMPAY_WEBHOOK_CONFIG` vaut
 * `DISABLED_CAMPAY_WEBHOOK` (503 sans lecture, sans base ni prestataire).
 * Aucune variable d'environnement ne l'active ; seuls les tests du lot le
 * remplacent (`overrideProvider`).
 *
 * 1-15F — `SubscriptionSignalsService` (exporté) : signaux temps réel après
 * écriture validée, branchés par `EventsGateway` (qui importe déjà ce
 * module). Le modèle `OrganizationMembership` est enregistré en LECTURE
 * seule pour désigner le propriétaire réel, sans importer
 * `OrganizationsModule`.
 *
 * 1-16A — `PushModule` (feuille) : travail « paiement confirmé » enregistré
 * dans la transaction d'attribution.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SubscriptionPeriod.name, schema: SubscriptionPeriodSchema },
      { name: Organization.name, schema: OrganizationSchema },
      {
        name: OrganizationMembership.name,
        schema: OrganizationMembershipSchema,
      },
      { name: SubscriptionPayment.name, schema: SubscriptionPaymentSchema },
      {
        name: SubscriptionPaymentReconciliation.name,
        schema: SubscriptionPaymentReconciliationSchema,
      },
    ]),
    // 1-16A : outbox des notifications (module feuille, aucun cycle).
    PushModule,
  ],
  controllers: [
    SubscriptionsController,
    SubscriptionPaymentsController,
    CamPayWebhookController,
  ],
  providers: [
    SubscriptionsService,
    SubscriptionPeriodIndexCheck,
    SubscriptionSignalsService,
    { provide: SUBSCRIPTION_CLOCK, useValue: systemSubscriptionClock },
    {
      provide: SUBSCRIPTION_MONOTONIC_CLOCK,
      useValue: systemMonotonicClock,
    },
    SubscriptionPaymentsService,
    SubscriptionPaymentIndexCheck,
    SubscriptionPaymentThrottlerGuard,
    { provide: PAYMENT_PROVIDER, useClass: UnavailablePaymentProvider },
    PaymentWebhookThrottlerGuard,
    CamPayWebhookService,
    { provide: CAMPAY_WEBHOOK_CONFIG, useValue: DISABLED_CAMPAY_WEBHOOK },
    // 1-14D.2G : rapprochement opérateur, utilisé par le CLI uniquement
    // (aucun contrôleur ; fournisseur injecté `PAYMENT_PROVIDER`).
    PaymentReconciliationService,
  ],
  exports: [SubscriptionsService, SubscriptionSignalsService],
})
export class SubscriptionsModule {}
