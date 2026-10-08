import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Sale, SaleSchema } from './schemas/sale.schema';
import {
  SaleOperation,
  SaleOperationSchema,
} from './schemas/sale-operation.schema';
import { SalesService } from './sales.service';
import { SalesController } from './sales.controller';
import { SaleOperationIndexCheck } from './sale-operation-index';
import { ProductsModule } from '../products/products.module';
import { EventsModule } from '../events/events.module';
import { AuditModule } from '../audit/audit.module';
import { PushModule } from '../push/push.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Sale.name, schema: SaleSchema },
      // 1-11C.1 : trace idempotente des créations de vente.
      { name: SaleOperation.name, schema: SaleOperationSchema },
    ]),
    ProductsModule,
    EventsModule,
    AuditModule,
    // 1-16A : travail « stock épuisé » enregistré dans la transaction.
    PushModule,
  ],
  providers: [SalesService, SaleOperationIndexCheck],
  controllers: [SalesController],
})
export class SalesModule {}
