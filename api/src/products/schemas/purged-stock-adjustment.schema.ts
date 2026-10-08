import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type PurgedStockAdjustmentDocument =
  HydratedDocument<PurgedStockAdjustment>;

export const PURGED_STOCK_ADJUSTMENTS_COLLECTION = 'purged_stock_adjustments';

/**
 * 1-15D — écart figé à la suppression définitive d'un produit, pour que la
 * vue d'ensemble garde EXACTEMENT sa règle comptable existante.
 *
 * Tant que le produit existe, son coût des ventes y est
 * `prix d'achat × (stock initial − stock restant)` ; après la purge, il est
 * porté par ses ventes (`lastKnownUnitCost × quantité`). Les deux quantités
 * sont égales par construction des opérations de stock, SAUF si elles ont
 * déjà divergé (écriture perdue d'un ajout de stock concurrent d'une vente,
 * données anciennes). L'écart, en unités, est alors conservé ici :
 * `units = (initial − restant) − Σ quantités vendues` au moment de la purge.
 *
 * Écrit dans la transaction de purge, et SEULEMENT si l'écart est non nul.
 * Aucun nom, aucune image, aucun autre champ du produit.
 */
@Schema({
  collection: PURGED_STOCK_ADJUSTMENTS_COLLECTION,
  timestamps: { createdAt: true, updatedAt: false },
})
export class PurgedStockAdjustment {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  })
  organizationId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  /** Prix d'achat unitaire du produit au moment de la purge. */
  @Prop({ type: Number, required: true, min: 0 })
  unitCost: number;

  /** Écart en unités (peut être négatif). */
  @Prop({ type: Number, required: true })
  units: number;
}

export const PurgedStockAdjustmentSchema = SchemaFactory.createForClass(
  PurgedStockAdjustment,
);
