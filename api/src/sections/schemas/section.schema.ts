import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type SectionDocument = HydratedDocument<Section>;

@Schema({ timestamps: true })
export class Section {
  /**
   * Rattachement organisationnel (phase 1-1B). Rétrocompatible : `null` sur
   * les documents existants, à remplir par la migration (phase 1-2) ; jamais
   * fourni par le client.
   *
   * **Frontière d'isolation multi-tenant** : le type doit résolument être
   * `ObjectId`, pas `Mixed`. Déclaration via `MongooseSchema.Types.ObjectId`
   * car `@nestjs/mongoose@11.0.4` résout une classe BSON passée en
   * `@Prop({ type })` comme définition de classe imbriquée (le chemin
   * `parentId` existant, même déclaration BSON, est affecté de la même
   * façon : dette préexistante, hors périmètre 1-1B, cf. rapport de phase).
   */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    default: null,
    required: false,
  })
  organizationId: Types.ObjectId | null;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ trim: true, default: '' })
  description: string;

  @Prop({ type: Date, default: null })
  deletedAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'Section', default: null })
  parentId: Types.ObjectId | null;
}

export const SectionSchema = SchemaFactory.createForClass(Section);

/**
 * Index tenant composite (1-1B) : rattachement premier, puis arborescence.
 * Déclaré uniquement — sa création (et celle des index ci-après) est
 * reportée à la migration RoyalVibe (phase 1-2), jamais exécutée ici
 * contre MongoDB/Atlas.
 */
SectionSchema.index({
  organizationId: 1,
  parentId: 1,
  deletedAt: 1,
});
