import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AnalyticsService } from '../analytics/analytics.service';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import {
  Organization,
  OrganizationDocument,
} from '../organizations/schemas/organization.schema';
import { OrganizationStatus } from '../organizations/permissions';
import {
  MonthlyReport,
  MonthlyReportDocument,
  MonthlyReportProduct,
  MonthlyReportSeller,
  MonthlyReportUnsoldProduct,
} from './schemas/monthly-report.schema';

/** Nombre de rangs du classement (ex æquo du dernier rang inclus). */
export const MONTHLY_TOP_PRODUCTS = 5;

export interface ReportPeriod {
  period: string;
  start: Date;
  end: Date;
}

/**
 * Mois civil COMPLET précédant `now`, bornes calculées comme
 * `AnalyticsService.monthMatch` : `new Date(année, mois, 1)` dans le fuseau
 * du processus API (début inclus, fin exclue).
 */
export function previousReportPeriod(now: Date): ReportPeriod {
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 1);
  const month = String(start.getMonth() + 1).padStart(2, '0');
  return { period: `${start.getFullYear()}-${month}`, start, end };
}

interface RankingRow {
  productId: Types.ObjectId;
  productName: string | null;
  productDeleted: boolean;
  totalUnitsSold: number;
  transactionCount: number;
}

interface SellerRow {
  sellerId: Types.ObjectId;
  sellerName: string;
  totalRevenue: number;
  totalUnitsSold: number;
}

/**
 * Classement par quantité nette décroissante ; le dernier rang retenu inclut
 * tous ses ex æquo (un 6e produit à égalité avec le 5e est affiché).
 * Égalités ordonnées par nom pour un affichage stable.
 */
export function topProducts(
  rows: readonly RankingRow[],
  limit: number = MONTHLY_TOP_PRODUCTS,
): MonthlyReportProduct[] {
  const sold = rows
    .filter((r) => r.totalUnitsSold > 0)
    .sort(
      (a, b) =>
        b.totalUnitsSold - a.totalUnitsSold ||
        (a.productName ?? '').localeCompare(b.productName ?? '') ||
        String(a.productId).localeCompare(String(b.productId)),
    );
  if (sold.length <= limit) return sold.map(toProduct);
  const threshold = sold[limit - 1].totalUnitsSold;
  return sold.filter((r) => r.totalUnitsSold >= threshold).map(toProduct);
}

function toProduct(row: RankingRow): MonthlyReportProduct {
  return {
    productId: new Types.ObjectId(String(row.productId)),
    name: row.productName ?? null,
    deleted: row.productDeleted === true,
    units: row.totalUnitsSold,
  };
}

/** Tous les vendeurs au chiffre d'affaires net maximal ; aucun sans vente. */
export function sellersOfMonth(
  rows: readonly SellerRow[],
): MonthlyReportSeller[] {
  if (rows.length === 0) return [];
  const best = Math.max(...rows.map((r) => r.totalRevenue));
  return rows
    .filter((r) => r.totalRevenue === best)
    .map((r) => ({
      sellerId: new Types.ObjectId(String(r.sellerId)),
      name: r.sellerName,
      revenue: r.totalRevenue,
      units: r.totalUnitsSold,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 1-16A.1 — Bilan mensuel.
 *
 * Règles reprises des analyses (`GET /analytics/*?month=AAAA-MM`) :
 * - ventes du mois selon `occurredAt` (sinon `createdAt`) ;
 * - corrections : quantité et prix COURANTS de la vente (une correction
 *   remplace la valeur), annulations : vente supprimée, donc absente ;
 * - vendeur : `sellerId` enregistré, jamais l'auteur d'une correction ;
 * - produits groupés par identifiant ; nom courant, sinon nom historique
 *   figé à la purge (1-15D), sinon dernier nom enregistré par une vente.
 *
 * Produits sans vente : catalogue encore présent (actif ou en corbeille)
 * créé avant la fin du mois et non mis en corbeille avant son début ; un
 * produit purgé sans vente du mois n'a plus aucune trace et n'est pas listé.
 */
@Injectable()
export class MonthlyReportService {
  constructor(
    private readonly analytics: AnalyticsService,
    @InjectModel(MonthlyReport.name)
    private readonly reportModel: Model<MonthlyReportDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Organization.name)
    private readonly organizationModel: Model<OrganizationDocument>,
  ) {}

  async compute(
    organizationId: Types.ObjectId,
    range: ReportPeriod,
    computedAt: Date,
  ): Promise<MonthlyReport> {
    const orgId = organizationId.toHexString();
    const [ranking, sellers] = await Promise.all([
      this.analytics.getProductsRanking(orgId, range.period) as Promise<
        RankingRow[]
      >,
      this.analytics.getSellersRanking(orgId, range.period) as Promise<
        SellerRow[]
      >,
    ]);
    const soldIds = new Set(ranking.map((r) => String(r.productId)));
    const catalog = await this.productModel
      .find({
        organizationId,
        createdAt: { $lt: range.end },
        $or: [{ deletedAt: null }, { deletedAt: { $gte: range.start } }],
      })
      .select({ name: 1, createdAt: 1, deletedAt: 1 })
      .sort({ name: 1, _id: 1 })
      .lean<
        Array<{
          _id: Types.ObjectId;
          name: string;
          createdAt: Date;
          deletedAt: Date | null;
        }>
      >()
      .exec();
    const unsold: MonthlyReportUnsoldProduct[] = catalog
      .filter((p) => !soldIds.has(p._id.toHexString()))
      .map((p) => ({
        productId: p._id,
        name: p.name,
        introducedDuringMonth: p.createdAt >= range.start,
        inTrash: p.deletedAt !== null && p.deletedAt !== undefined,
      }));
    return {
      organizationId,
      period: range.period,
      periodStart: range.start,
      periodEnd: range.end,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
      computedAt,
      salesCount: ranking.reduce((s, r) => s + (r.transactionCount ?? 0), 0),
      topProducts: topProducts(ranking),
      sellersOfMonth: sellersOfMonth(sellers),
      unsoldProducts: unsold,
    };
  }

  /**
   * Bilans DUS à `now` : mois précédent uniquement (jamais les mois plus
   * anciens : aucune rafale à l'activation), organisations actives créées
   * avant la fin de ce mois. Idempotent (index unique) ; renvoie les bilans
   * existants ou créés, pour l'enregistrement (idempotent) des événements.
   */
  async generateDue(now: Date): Promise<
    Array<{
      organizationId: Types.ObjectId;
      reportId: Types.ObjectId;
      period: string;
    }>
  > {
    const range = previousReportPeriod(now);
    const organizations = await this.organizationModel
      .find({
        status: OrganizationStatus.ACTIVE,
        createdAt: { $lt: range.end },
      })
      .select({ _id: 1 })
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    if (organizations.length === 0) return [];
    const existing = await this.reportModel
      .find({
        period: range.period,
        organizationId: { $in: organizations.map((o) => o._id) },
      })
      .select({ organizationId: 1 })
      .lean<Array<{ _id: Types.ObjectId; organizationId: Types.ObjectId }>>()
      .exec();
    const byOrg = new Map(
      existing.map((r) => [r.organizationId.toHexString(), r._id]),
    );
    for (const { _id: organizationId } of organizations) {
      if (byOrg.has(organizationId.toHexString())) continue;
      const report = await this.compute(organizationId, range, now);
      try {
        const created = await this.reportModel.create(report);
        byOrg.set(organizationId.toHexString(), created._id);
      } catch (error) {
        if ((error as { code?: unknown }).code !== 11000) throw error;
        const raced = await this.reportModel
          .findOne({ organizationId, period: range.period })
          .select({ _id: 1 })
          .lean<{ _id: Types.ObjectId }>()
          .exec();
        if (raced) byOrg.set(organizationId.toHexString(), raced._id);
      }
    }
    return [...byOrg.entries()].map(([organizationId, reportId]) => ({
      organizationId: new Types.ObjectId(organizationId),
      reportId,
      period: range.period,
    }));
  }
}
