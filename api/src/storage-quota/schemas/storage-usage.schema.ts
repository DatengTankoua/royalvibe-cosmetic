import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type StorageUsageDocument = HydratedDocument<StorageUsage>;

export const STORAGE_USAGES_COLLECTION = 'storage_usages';

/**
 * 1-17B — Compteur d'occupation d'UNE organisation (`_id` = identifiant de
 * l'organisation : unicité native, aucune migration d'index).
 *
 * Point d'écriture unique de la réservation : l'incrément conditionnel
 * (`stored + reserved + n ≤ quota`) sur ce document sérialise les envois
 * concurrents. Chaque variation est écrite dans la MÊME transaction que
 * l'entrée correspondante du registre `storage_objects` ; le recalcul
 * (`recompute`) le reconstruit depuis ce registre.
 */
@Schema({ collection: STORAGE_USAGES_COLLECTION, timestamps: true })
export class StorageUsage {
  @Prop({ type: Types.ObjectId, required: true })
  _id: Types.ObjectId;

  /** Octets des fichiers effectivement envoyés (`uploaded`, `attached`, `deleting`). */
  @Prop({ type: Number, default: 0 })
  storedBytes: number;

  @Prop({ type: Number, default: 0 })
  storedObjects: number;

  /** Octets réservés par des envois en cours ou interrompus (`reserved`). */
  @Prop({ type: Number, default: 0 })
  reservedBytes: number;

  @Prop({ type: Number, default: 0 })
  reservedObjects: number;
}

export const StorageUsageSchema = SchemaFactory.createForClass(StorageUsage);
