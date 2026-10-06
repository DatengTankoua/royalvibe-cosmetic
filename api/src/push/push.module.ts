import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  PushSubscriptionRecord,
  PushSubscriptionSchema,
} from './schemas/push-subscription.schema';
import { PushJob, PushJobSchema } from './schemas/push-job.schema';
import {
  PushDelivery,
  PushDeliverySchema,
} from './schemas/push-delivery.schema';
import { NotificationsModule } from '../notifications/notifications.module';
import { Sale, SaleSchema } from '../sales/schemas/sale.schema';
import {
  MonthlyReport,
  MonthlyReportSchema,
} from '../notifications/schemas/monthly-report.schema';
import { PushOutboxService } from './push-outbox.service';
import { PushDispatcherService } from './push-dispatcher.service';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { PushController } from './push.controller';
import { User, UserSchema } from '../users/schemas/user.schema';
import {
  Organization,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import {
  OrganizationMembership,
  OrganizationMembershipSchema,
} from '../organizations/schemas/membership.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import {
  SubscriptionPayment,
  SubscriptionPaymentSchema,
} from '../subscriptions/payments/schemas/subscription-payment.schema';
import {
  SubscriptionPeriod,
  SubscriptionPeriodSchema,
} from '../subscriptions/schemas/subscription-period.schema';

/**
 * 1-16A — Notifications Web Push métier.
 *
 * Module FEUILLE : n'importe aucun module métier (importé par
 * `SubscriptionsModule` et `SalesModule` sans dépendance circulaire) ; les
 * modèles métier sont enregistrés en LECTURE pour revalider pertinence et
 * destinataires avant chaque envoi.
 *
 * Rien n'est actif au chargement : `PushRuntime` (fourni par
 * `NotificationsModule`) reste inactif tant que le démarrage HTTP
 * (`startNotifications`) ne l'a pas activé ; aucun fournisseur n'implémente
 * `OnModuleInit` / `OnApplicationBootstrap`.
 */
@Module({
  imports: [
    // 1-16A.1 : runtime, horloge, centre et bilans (module de base).
    NotificationsModule,
    MongooseModule.forFeature([
      { name: PushSubscriptionRecord.name, schema: PushSubscriptionSchema },
      { name: PushJob.name, schema: PushJobSchema },
      { name: PushDelivery.name, schema: PushDeliverySchema },
      { name: User.name, schema: UserSchema },
      { name: Organization.name, schema: OrganizationSchema },
      {
        name: OrganizationMembership.name,
        schema: OrganizationMembershipSchema,
      },
      { name: Product.name, schema: ProductSchema },
      { name: SubscriptionPayment.name, schema: SubscriptionPaymentSchema },
      { name: SubscriptionPeriod.name, schema: SubscriptionPeriodSchema },
      { name: Sale.name, schema: SaleSchema },
      { name: MonthlyReport.name, schema: MonthlyReportSchema },
    ]),
  ],
  controllers: [PushController],
  providers: [
    PushOutboxService,
    PushDispatcherService,
    PushSubscriptionsService,
  ],
  exports: [PushOutboxService, PushDispatcherService],
})
export class PushModule {}
