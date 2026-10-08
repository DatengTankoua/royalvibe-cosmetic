import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type MonthlyReportDocument = HydratedDocument<MonthlyReport>;

export const MONTHLY_REPORTS_COLLECTION = 'monthly_reports';

export interface MonthlyReportProduct {
  productId: Types.ObjectId;
  name: string | null;
  /** Produit supprimé définitivement (nom historique 1-15D). */
  deleted: boolean;
  /** Quantité nette vendue (ventes existantes après corrections). */
  units: number;
}

export interface MonthlyReportSeller {
  sellerId: Types.ObjectId;
  name: string;
  /** Chiffre d'affaires net enregistré (prix de vente × quantité). */
  revenue: number;
  units: number;
}

export interface MonthlyReportUnsoldProduct {
  productId: Types.ObjectId;
  name: string;
  /** Créé pendant le mois du bilan. */
  introducedDuringMonth: boolean;
  /** Actuellement dans la corbeille (suppression douce). */
  inTrash: boolean;
}

/**
 * 1-16A.1 — Bilan d'UNE organisation pour UN mois civil complet (unique
 * `{organizationId, period}` : génération idempotente). Calculé avec les
 * règles et bornes des analyses existantes (`AnalyticsService`, mois civil
 * dans le fuseau du processus API) au moment `computedAt`.
 *
 * Aucun coût, prix d'achat, bénéfice ni marge : ni calculé ni stocké. Le
 * bilan n'est jamais supprimé avec ses notifications.
 */
@Schema({
  collection: MONTHLY_REPORTS_COLLECTION,
  timestamps: true,
  autoIndex: false,
})
export class MonthlyReport {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  })
  organizationId: Types.ObjectId;

  /** `AAAA-MM` (même format que `?month=` des analyses). */
  @Prop({ type: String, required: true, match: /^\d{4}-\d{2}$/ })
  period: string;

  @Prop({ type: Date, required: true })
  periodStart: Date;

  /** Exclue. */
  @Prop({ type: Date, required: true })
  periodEnd: Date;

  /** Fuseau du processus API utilisé pour les bornes. */
  @Prop({ type: String, required: true, maxlength: 64 })
  timeZone: string;

  @Prop({ type: Date, required: true })
  computedAt: Date;

  @Prop({ type: Number, required: true })
  salesCount: number;

  @Prop({ type: [Object], required: true })
  topProducts: MonthlyReportProduct[];

  @Prop({ type: [Object], required: true })
  sellersOfMonth: MonthlyReportSeller[];

  @Prop({ type: [Object], required: true })
  unsoldProducts: MonthlyReportUnsoldProduct[];
}

export const MonthlyReportSchema = SchemaFactory.createForClass(MonthlyReport);
