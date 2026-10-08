import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type SaleOperationDocument = HydratedDocument<SaleOperation>;

export const SALE_OPERATIONS_COLLECTION = 'sale_operations';

/**
 * 1-11C.1 — Trace idempotente d'une création de vente (`POST /sales` avec
 * `clientOperationId`).
 *
 * Collection DÉDIÉE plutôt qu'un champ sur `Sale` : `DELETE /sales/:id`
 * supprime physiquement la vente ; la clé doit lui survivre pour qu'un rejeu
 * tardif ne recrée jamais une vente annulée (→ 409
 * `SALE_OPERATION_ALREADY_APPLIED`).
 *
 * Écrite en PREMIÈRE écriture de la transaction de vente : un rollback
 * (stock insuffisant, échec d'audit…) l'annule avec le reste.
 *
 * `autoIndex: false` : l'index unique n'est JAMAIS créé silencieusement au
 * démarrage. Il est créé par la migration dédiée
 * (`migrations/create-sale-operations-index.ts`) et vérifié fail-fast en
 * production (`SaleOperationIndexCheck`). Aucun TTL.
 */
@Schema({
  collection: SALE_OPERATIONS_COLLECTION,
  timestamps: { createdAt: true, updatedAt: false },
  autoIndex: false,
})
export class SaleOperation {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  })
  organizationId: Types.ObjectId;

  @Prop({ type: String, required: true })
  clientOperationId: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  sellerId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Sale', required: true })
  saleId: Types.ObjectId;

  /** SHA-256 hex du payload canonique, calculé côté serveur uniquement. */
  @Prop({ type: String, required: true })
  requestHash: string;
}

export const SaleOperationSchema = SchemaFactory.createForClass(SaleOperation);

/** Clé EXACTE de l'index unique tenant (ordre significatif). */
export const SALE_OPERATION_INDEX_KEY = Object.freeze({
  organizationId: 1,
  clientOperationId: 1,
} as const);

SaleOperationSchema.index({ ...SALE_OPERATION_INDEX_KEY }, { unique: true });
