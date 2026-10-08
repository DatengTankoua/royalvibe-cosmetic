import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AnalyticsModule } from '../analytics/analytics.module';
import { Sale, SaleSchema } from '../sales/schemas/sale.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import {
  Organization,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import { AuditLog, AuditLogSchema } from '../audit/schemas/audit-log.schema';
import { MonthlyHistoryService } from './monthly-history.service';
import { MonthlyHistoryController } from './monthly-history.controller';
import {
  REPORT_GENERATION_LIMITS,
  REPORT_GENERATION_LIMITS_TOKEN,
  ReportGenerationLimiter,
} from './report-generation-limiter';

/** 1-16D — historique mensuel exportable (Excel, PDF). Lecture seule. */
@Module({
  imports: [
    AnalyticsModule,
    MongooseModule.forFeature([
      { name: Sale.name, schema: SaleSchema },
      { name: Product.name, schema: ProductSchema },
      { name: User.name, schema: UserSchema },
      { name: Organization.name, schema: OrganizationSchema },
      { name: AuditLog.name, schema: AuditLogSchema },
    ]),
  ],
  providers: [
    MonthlyHistoryService,
    ReportGenerationLimiter,
    // Paramètres centralisés (remplaçables dans les tests).
    {
      provide: REPORT_GENERATION_LIMITS_TOKEN,
      useValue: REPORT_GENERATION_LIMITS,
    },
  ],
  controllers: [MonthlyHistoryController],
})
export class ReportsModule {}
