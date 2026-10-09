import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { S3Module } from '../s3/s3.module';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import {
  Organization,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import {
  StoredObject,
  StoredObjectSchema,
} from './schemas/stored-object.schema';
import {
  StorageUsage,
  StorageUsageSchema,
} from './schemas/storage-usage.schema';
import { StorageQuotaService } from './storage-quota.service';
import { StorageQuotaController } from './storage-quota.controller';

/**
 * 1-17B — Quotas de stockage. Modèles `Product` et `Organization` en
 * LECTURE (références d'un fichier), aucune dépendance de module métier :
 * importable par les produits et les organisations sans cycle.
 */
@Module({
  imports: [
    S3Module,
    MongooseModule.forFeature([
      { name: StoredObject.name, schema: StoredObjectSchema },
      { name: StorageUsage.name, schema: StorageUsageSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Organization.name, schema: OrganizationSchema },
    ]),
  ],
  controllers: [StorageQuotaController],
  providers: [StorageQuotaService],
  exports: [StorageQuotaService],
})
export class StorageQuotaModule {}
