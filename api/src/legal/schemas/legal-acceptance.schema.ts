import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  HydratedDocument,
  Schema as MongooseSchema,
  Types,
  type Schema as SchemaType,
} from 'mongoose';
import { LegalAcceptanceContext } from '../legal-documents';

export const LEGAL_ACCEPTANCES_COLLECTION = 'legal_acceptances';
export const LEGAL_DOCUMENT_VERSIONS_COLLECTION = 'legal_document_versions';

const QUERY_MUTATIONS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;

/**
 * 1-16C.2 — Archive IMMUABLE côté application : aucune modification ni
 * suppression par les modèles Mongoose (requêtes et documents). Seules des
 * insertions sont possibles ; l'archivage d'une version passe par un
 * `$setOnInsert` sur la collection (jamais une réécriture). Une écriture
 * directe en base par un administrateur reste techniquement possible : cette
 * garde ne la remplace pas (voir le rapport 1-16C.2).
 */
export function forbidMutations(schema: SchemaType, label: string): void {
  const refuse = () => {
    throw new Error(`${label} : archive immuable, écriture refusée.`);
  };
  for (const op of QUERY_MUTATIONS) {
    schema.pre(op, { document: false, query: true }, refuse);
  }
  schema.pre('deleteOne', { document: true, query: false }, refuse);
  schema.pre('save', function (this: { isNew: boolean }) {
    if (!this.isNew) refuse();
  });
}

/** Document tel qu'enregistré : version, langue et empreinte du SERVEUR. */
@Schema({ _id: false, versionKey: false })
export class LegalDocumentProof {
  @Prop({ type: String, required: true }) documentId: string;
  @Prop({ type: String, required: true }) version: string;
  @Prop({ type: String, required: true }) locale: string;
  @Prop({ type: String, required: true }) sha256: string;
  /** `_id` du texte dans `legal_document_versions`. */
  @Prop({ type: String, required: true }) archiveId: string;
}
const LegalDocumentProofSchema =
  SchemaFactory.createForClass(LegalDocumentProof);

/**
 * Preuve d'acceptation, une par action explicite. `_id` déterministe
 * (empreinte de l'utilisateur, du commerce, du parcours et des versions
 * acceptées) : un rejeu ne crée jamais une seconde preuve (index `_id`
 * natif, aucune migration requise pour l'unicité).
 */
@Schema({
  collection: LEGAL_ACCEPTANCES_COLLECTION,
  autoIndex: false,
  versionKey: false,
})
export class LegalAcceptance {
  @Prop({ type: String, required: true })
  _id: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  /** Commerce concerné (création, invitation, compte confirmé). */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    default: null,
  })
  organizationId: Types.ObjectId | null;

  @Prop({
    type: String,
    enum: Object.values(LegalAcceptanceContext),
    required: true,
  })
  context: LegalAcceptanceContext;

  /** Date du SERVEUR (horloge injectable), jamais du navigateur. */
  @Prop({ type: Date, required: true })
  acceptedAt: Date;

  @Prop({ type: String, required: true })
  locale: string;

  /** Documents ACCEPTÉS (case cochée). */
  @Prop({ type: [LegalDocumentProofSchema], required: true })
  acceptedDocuments: LegalDocumentProof[];

  /** Documents PRÉSENTÉS pour information (sans accord). */
  @Prop({ type: [LegalDocumentProofSchema], default: [] })
  presentedNotices: LegalDocumentProof[];
}

export type LegalAcceptanceDocument = HydratedDocument<LegalAcceptance>;
export const LegalAcceptanceSchema =
  SchemaFactory.createForClass(LegalAcceptance);
forbidMutations(LegalAcceptanceSchema, LEGAL_ACCEPTANCES_COLLECTION);

/**
 * Texte d'une version acceptée, archivé en base à sa première acceptation
 * (`_id` = `<document>@<version>/<langue>`). Jamais réécrit : une version
 * déjà archivée avec une autre empreinte bloque l'acceptation.
 */
@Schema({
  collection: LEGAL_DOCUMENT_VERSIONS_COLLECTION,
  autoIndex: false,
  versionKey: false,
})
export class LegalDocumentVersion {
  @Prop({ type: String, required: true }) _id: string;
  @Prop({ type: String, required: true }) documentId: string;
  @Prop({ type: String, required: true }) version: string;
  @Prop({ type: String, required: true }) locale: string;
  @Prop({ type: String, required: true }) sha256: string;
  @Prop({ type: String, required: true }) text: string;
  /** Date de publication déclarée dans le manifeste (AAAA-MM-JJ). */
  @Prop({ type: String, required: true }) publishedAt: string;
  /** Première archive en base (date serveur). */
  @Prop({ type: Date, required: true }) archivedAt: Date;
}

export type LegalDocumentVersionDocument =
  HydratedDocument<LegalDocumentVersion>;
export const LegalDocumentVersionSchema =
  SchemaFactory.createForClass(LegalDocumentVersion);
forbidMutations(LegalDocumentVersionSchema, LEGAL_DOCUMENT_VERSIONS_COLLECTION);
