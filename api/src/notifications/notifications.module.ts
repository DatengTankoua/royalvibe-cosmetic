import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AppNotification,
  AppNotificationSchema,
} from './schemas/notification.schema';
import {
  NotificationPreference,
  NotificationPreferenceSchema,
} from './schemas/notification-preference.schema';
import {
  MonthlyReport,
  MonthlyReportSchema,
} from './schemas/monthly-report.schema';
import { NotificationCenterService } from './notification-center.service';
import { NotificationSignalsService } from './notification-signals.service';
import { MonthlyReportService } from './monthly-report.service';
import { NotificationsController } from './notifications.controller';
import { PUSH_CLOCK, PushRuntime, systemPushClock } from '../push/push-runtime';
import { AnalyticsModule } from '../analytics/analytics.module';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { Sale, SaleSchema } from '../sales/schemas/sale.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import {
  Organization,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import {
  SubscriptionPayment,
  SubscriptionPaymentSchema,
} from '../subscriptions/payments/schemas/subscription-payment.schema';

/**
 * 1-16A.1 — Centre de notifications, bilans mensuels et état d'activation.
 *
 * Module de BASE des notifications : fournit `PushRuntime` et `PUSH_CLOCK`
 * (importé par `PushModule`, `EventsModule`), n'importe que
 * `AnalyticsModule` (aucun cycle). Modèles métier enregistrés en LECTURE
 * pour les détails revalidés.
 *
 * Rien n'est actif au chargement : aucun fournisseur `OnModuleInit` /
 * `OnApplicationBootstrap` ; génération et répartition passent par le
 * dispatcher, démarré uniquement par le processus HTTP.
 */
@Module({
  imports: [
    AnalyticsModule,
    MongooseModule.forFeature([
      { name: AppNotification.name, schema: AppNotificationSchema },
      {
        name: NotificationPreference.name,
        schema: NotificationPreferenceSchema,
      },
      { name: MonthlyReport.name, schema: MonthlyReportSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Sale.name, schema: SaleSchema },
      { name: User.name, schema: UserSchema },
      { name: Organization.name, schema: OrganizationSchema },
      { name: SubscriptionPayment.name, schema: SubscriptionPaymentSchema },
    ]),
  ],
  controllers: [NotificationsController],
  providers: [
    PushRuntime,
    { provide: PUSH_CLOCK, useValue: systemPushClock },
    NotificationCenterService,
    NotificationSignalsService,
    MonthlyReportService,
  ],
  exports: [
    PushRuntime,
    PUSH_CLOCK,
    NotificationCenterService,
    NotificationSignalsService,
    MonthlyReportService,
  ],
})
export class NotificationsModule {}
