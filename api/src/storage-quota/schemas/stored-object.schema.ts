import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import type { StoredObjectKind } from '../storage-prefixes';

export type StoredObjectDocument = HydratedDocument<StoredObject>;

export const STORED_OBJECTS_COLLECTION = 'storage_objects';

/**
 * 1-17B — États d'un fichier comptabilisé :
 * - `reserved` : capacité réservée, envoi en cours (ou interrompu) ; compté
 *   dans `reservedBytes`. L'objet peut exister ou non dans le stockage.
 * - `uploaded` : objet ENVOYÉ, pas encore rattaché à un document ;
 *   compté dans `storedBytes`.
 * - `attached` : objet référencé par un produit (photo) ou une
 *   organisation (logo) ; compté dans `storedBytes`.
 * - `deleting` : plus référencé, suppression à faire ou à reprendre ;
 *   compté dans `storedBytes` jusqu'à suppression CONFIRMÉE.
 *
 * Une entrée n'est supprimée (et ses octets libérés) qu'après suppression
 * confirmée de l'objet ou absence confirmée par le stockage.
 */
export const STORED_OBJECT_STATES = [
  'reserved',
  'uploaded',
  'attached',
  'deleting',
] as const;
export type StoredObjectState = (typeof STORED_OBJECT_STATES)[number];

/** Identifiant DÉTERMINISTE (stockage + clé) : unicité par `_id` natif. */
export function storedObjectId(storage: string, key: string): string {
  return `${storage}::${key}`;
}

/**
 * Registre des fichiers comptabilisés (une entrée par objet du stockage
 * courant, sous le préfixe exact de son organisation). Jamais d'URL ; la
 * clé n'est jamais renvoyée par l'API.
 */
@Schema({ collection: STORED_OBJECTS_COLLECTION, timestamps: true })
export class StoredObject {
  @Prop({ type: String, required: true })
  _id: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  })
  organizationId: Types.ObjectId;

  /** Identité du stockage (`S3Service.storage`). */
  @Prop({ type: String, required: true })
  storage: string;

  @Prop({ type: String, required: true })
  key: string;

  @Prop({ type: String, required: true, enum: ['product_image', 'logo'] })
  kind: StoredObjectKind;

  /**
   * Octets comptés : taille envoyée (déterminée par le serveur) ou, pour
   * l'initialisation, `Content-Length` vérifié dans le stockage. Jamais 0
   * par défaut pour une taille inconnue (l'entrée n'est pas créée).
   */
  @Prop({ type: Number, required: true, min: 0 })
  bytes: number;

  @Prop({ type: String, required: true, enum: STORED_OBJECT_STATES })
  state: StoredObjectState;

  /**
   * Échéance après laquelle la reprise peut traiter l'entrée (`reserved`,
   * `uploaded`, `deleting`) ; `null` pour `attached`. Une échéance dépassée
   * ne prouve jamais l'absence du fichier : la reprise interroge le
   * stockage.
   */
  @Prop({ type: Date, default: null })
  leaseUntil: Date | null;

  /** Tentatives de reprise (suppression ou vérification) échouées. */
  @Prop({ type: Number, default: 0 })
  attempts: number;

  /**
   * `reconciliation` (1-17B) : fichier trouvé dans le stockage sans entrée
   * (envoi arrivé après la reprise, fichier écrit par un code antérieur).
   */
  @Prop({
    type: String,
    required: true,
    enum: ['upload', 'initialization', 'reconciliation'],
  })
  source: 'upload' | 'initialization' | 'reconciliation';
}

export const StoredObjectSchema = SchemaFactory.createForClass(StoredObject);

// Index de performance (non uniques ; l'unicité repose sur `_id`).
StoredObjectSchema.index({ state: 1, leaseUntil: 1 });
StoredObjectSchema.index({ organizationId: 1, state: 1 });
