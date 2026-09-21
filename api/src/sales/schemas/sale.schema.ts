import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type SaleDocument = HydratedDocument<Sale>;

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class Sale {
  /**
   * Rattachement organisationnel (phase 1-1B). Rétrocompatible : `null` sur
   * les documents existants, à remplir par la migration (phase 1-2) ; jamais
   * fourni par le client. `createdAt: -1` de l'index tenant ci-dessous
   * reflète le tri chronologique descendant du service
   * (`sales.service.ts`).
   *
   * **Frontière d'isolation multi-tenant** : le type doit résolument être
   * `ObjectId`, pas `Mixed`. Déclaration via `MongooseSchema.Types.ObjectId`
   * car `@nestjs/mongoose@11.0.4` résout une classe BSON passée en
   * `@Prop({ type })` comme définition de classe imbriquée (les chemins
   * `productId`/`sellerId` existants, même déclaration BSON, sont affectés
   * de la même façon : dette préexistante, hors périmètre 1-1B, cf. rapport
   * de phase).
   */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    default: null,
    required: false,
  })
  organizationId: Types.ObjectId | null;

  @Prop({ required: true, type: Types.ObjectId, ref: 'Product' })
  productId: Types.ObjectId;

  // snapshot so the name survives permanent product deletion
  @Prop()
  productName?: string;

  @Prop({ required: true, min: 1 })
  quantity: number;

  @Prop({ required: true, min: 0 })
  salePrice: number;

  @Prop({ required: true, type: Types.ObjectId, ref: 'User' })
  sellerId: Types.ObjectId;

  @Prop({ trim: true })
  buyerName?: string;

  @Prop({ trim: true })
  buyerContact?: string;
}

export const SaleSchema = SchemaFactory.createForClass(Sale);

/**
 * Index tenant composite (1-1B) : le service lit les ventes par
 * `createdAt` descendant (convention démontrée en lecture seule,
 * `sales.service.ts`), d'où l'ordre `organizationId → productId →
 * createdAt(-1)`. Déclaré uniquement — création reportée à la migration.
 */
SaleSchema.index({
  organizationId: 1,
  productId: 1,
  createdAt: -1,
});
