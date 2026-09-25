import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { OrganizationCurrency, OrganizationStatus } from '../permissions';

export type OrganizationDocument = HydratedDocument<Organization>;

@Schema({ timestamps: true })
export class Organization {
  /** Nom affiché (identité de l'organisation). Non vide après trim. */
  @Prop({ required: true, trim: true, minLength: 1, maxlength: 100 })
  name: string;

  /**
   * Identifiant stable de l'organisation. Format recommandé : lettres
   * minuscules, chiffres et tirets (`/^[0-9a-z-]+$/`). Index unique global
   * déclaré UNIQUEMENT ici, par `unique: true` (mongoose crée l'index) —
   * il ne faut pas le déclarer une seconde fois via `schema.index`.
   */
  @Prop({
    required: true,
    trim: true,
    lowercase: true,
    minlength: 1,
    maxlength: 80,
    match: /^[0-9a-z-]+$/,
    unique: true,
  })
  slug: string;

  /** Clé de stockage du logo (aucune URL stockée ici) ; null = logo par défaut. */
  @Prop({ type: String, default: null })
  logoKey: string | null;

  /**
   * Couleur d'accent `#RRGGBB` ; une seule couleur (décision D7).
   * Défaut `#FF6A00` (1-8A, palette Stock Master) — l'ancien défaut
   * RoyalVibe `#b8960c` n'est PAS migré (aucune organisation en production).
   */
  @Prop({ type: String, default: '#FF6A00', match: /^#[0-9a-fA-F]{6}$/ })
  brandColor: string;

  /** Devise de l'organisation ; défaut `XAF` (jamais `XOF`). */
  @Prop({
    type: String,
    enum: OrganizationCurrency,
    default: OrganizationCurrency.XAF,
  })
  currency: OrganizationCurrency;

  /** `active | suspended` ; org suspendue refusée par le contexte (1-3A). */
  @Prop({
    type: String,
    enum: OrganizationStatus,
    default: OrganizationStatus.ACTIVE,
  })
  status: OrganizationStatus;
}

export const OrganizationSchema = SchemaFactory.createForClass(Organization);
