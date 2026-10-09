import { Module } from '@nestjs/common';
import {
  PurgedStockAdjustment,
  PurgedStockAdjustmentSchema,
} from './schemas/purged-stock-adjustment.schema';

import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from './schemas/product.schema';
import { Sale, SaleSchema } from '../sales/schemas/sale.schema';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { S3Module } from '../s3/s3.module';
import { StorageQuotaModule } from '../storage-quota/storage-quota.module';
import { EventsModule } from '../events/events.module';
import { AuditModule } from '../audit/audit.module';
import { Section, SectionSchema } from '../sections/schemas/section.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: Sale.name, schema: SaleSchema },
      { name: Section.name, schema: SectionSchema },
      // 1-15D : écart figé à la purge (vue d'ensemble).
      {
        name: PurgedStockAdjustment.name,
        schema: PurgedStockAdjustmentSchema,
      },
    ]),
    S3Module,
    StorageQuotaModule,
    EventsModule,
    AuditModule,
  ],
  providers: [ProductsService],
  controllers: [ProductsController],
  exports: [ProductsService],
})
export class ProductsModule {}
