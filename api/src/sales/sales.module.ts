import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Sale, SaleSchema } from './schemas/sale.schema';
import { SalesService } from './sales.service';
import { SalesController } from './sales.controller';
import { ProductsModule } from '../products/products.module';
import { EventsModule } from '../events/events.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Sale.name, schema: SaleSchema }]),
    ProductsModule,
    EventsModule,
    AuditModule,
  ],
  providers: [SalesService],
  controllers: [SalesController],
})
export class SalesModule {}
