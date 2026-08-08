import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Sale, SaleSchema } from '../sales/schemas/sale.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Sale.name, schema: SaleSchema },
      { name: Product.name, schema: ProductSchema },
    ]),
  ],
  providers: [AnalyticsService],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
