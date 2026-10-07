import { Module } from '@nestjs/common';
import {
  PurgedStockAdjustment,
  PurgedStockAdjustmentSchema,
} from '../products/schemas/purged-stock-adjustment.schema';

import { MongooseModule } from '@nestjs/mongoose';
import { Sale, SaleSchema } from '../sales/schemas/sale.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import {
  Organization,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Sale.name, schema: SaleSchema },
      { name: Product.name, schema: ProductSchema },
      {
        name: PurgedStockAdjustment.name,
        schema: PurgedStockAdjustmentSchema,
      },
      // 1-16E : date de création du commerce (début d'observation).
      { name: Organization.name, schema: OrganizationSchema },
    ]),
  ],
  providers: [AnalyticsService],
  controllers: [AnalyticsController],
  // 1-16A.1 : bilan mensuel calculé avec les MÊMES règles et bornes.
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
