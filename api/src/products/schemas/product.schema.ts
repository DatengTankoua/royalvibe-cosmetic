import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type ProductDocument = HydratedDocument<Product>;

@Schema({ timestamps: true })
export class Product {
  /**
   * Rattachement organisationnel (phase 1-1B). Rétrocompatible : `null` sur
   * les documents existants, à remplir par la migration (phase 1-2) ; jamais
   * fourni par le client.
   *
   * **Frontière d'isolation multi-tenant** : le type doit résolument être
   * `ObjectId`, pas `Mixed`. Déclaration via `MongooseSchema.Types.ObjectId`
   * car `@nestjs/mongoose@11.0.4` résout une classe BSON passée en
   * `@Prop({ type })` comme définition de classe imbriquée (le chemin
   * `sectionId` existant, même déclaration BSON, est affecté de la même
   * façon : dette préexistante, hors périmètre 1-1B, cf. rapport de phase).
   */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    default: null,
    required: false,
  })
  organizationId: Types.ObjectId | null;

  @Prop({ required: true, type: Types.ObjectId, ref: 'Section' })
  sectionId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true })
  imageUrl: string;

  @Prop({ required: true, min: 0 })
  purchasePrice: number;

  @Prop({ required: true, min: 0 })
  salePrice: number;

  @Prop({ required: true, min: 1 })
  initialQuantity: number;

  @Prop({ required: true, min: 0 })
  remainingQuantity: number;

  @Prop({ type: Date, default: null })
  deletedAt: Date | null;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

/**
 * Index tenant composite (1-1B) : rattachement premier, puis section.
 * Déclaré uniquement — création reportée à la migration (phase 1-2).
 */
ProductSchema.index({
  organizationId: 1,
  sectionId: 1,
  deletedAt: 1,
});
