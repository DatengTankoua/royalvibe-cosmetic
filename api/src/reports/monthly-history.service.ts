import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AnalyticsService } from '../analytics/analytics.service';
import {
  monthBounds,
  processTimeZone,
  saleMonthMatch,
} from '../analytics/month-range';
import { Sale, SaleDocument } from '../sales/schemas/sale.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import {
  Organization,
  OrganizationDocument,
} from '../organizations/schemas/organization.schema';
import {
  AuditAction,
  AuditLog,
  AuditLogDocument,
} from '../audit/schemas/audit-log.schema';
import { hasPermission } from '../organizations/permissions';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import type {
  MonthlyHistory,
  MonthlyHistoryMovementLine,
  MonthlyHistoryProductLine,
  MonthlyHistorySaleLine,
  MonthlyHistorySellerLine,
  ProductState,
} from './monthly-history.types';

export const REPORT_MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const REPORT_MONTH_INVALID = 'REPORT_MONTH_INVALID';
export const REPORT_DATA_CHANGED = 'REPORT_DATA_CHANGED';
/** Relectures tentées si une vente change pendant la génération. */
const CONSISTENCY_ATTEMPTS = 3;
/** Plus ancien mois proposé (garde-fou de la liste, jamais une troncature). */
const MAX_LISTED_MONTHS = 240;

/** Mois `AAAA-MM` du processus API (fuseau des bornes). */
export function localMonthOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Mois demandé : format strict `AAAA-MM`, année ≥ 2000, jamais postérieur
 * au mois en cours (fuseau du processus API). Sinon 400.
 */
export function assertReportMonth(value: string, now: Date): string {
  const match = REPORT_MONTH_PATTERN.exec(value);
  if (!match || Number(match[1]) < 2000 || value > localMonthOf(now)) {
    throw new BadRequestException({
      code: REPORT_MONTH_INVALID,
      message: 'Mois invalide.',
    });
  }
  return value;
}

interface LeanSale {
  _id: Types.ObjectId;
  occurredAt?: Date | null;
  createdAt: Date;
  productId: Types.ObjectId;
  productName?: string;
  lastKnownProductName?: string;
  quantity: number;
  salePrice: number;
  sellerId: Types.ObjectId;
  buyerName?: string;
  buyerContact?: string;
}

interface OverviewRow {
  totalRevenue: number;
  unitsSold: number;
  totalTransactions: number;
}

interface ProductRankingRow {
  productId: Types.ObjectId;
  productName: string | null;
  productDeleted: boolean;
  totalUnitsSold: number;
  totalRevenue: number;
  transactionCount: number;
  netProfit: number | null;
}

interface SellerRankingRow {
  sellerId: Types.ObjectId;
  sellerName: string;
  totalUnitsSold: number;
  totalRevenue: number;
  transactionCount: number;
}

interface Totals {
  quantity: number;
  revenue: number;
  count: number;
}

const saleDate = (sale: { occurredAt?: Date | null; createdAt: Date }) =>
  sale.occurredAt ?? sale.createdAt;

function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

function sameTotals(a: Totals, b: Totals): boolean {
  return (
    a.count === b.count &&
    a.quantity === b.quantity &&
    sameAmount(a.revenue, b.revenue)
  );
}

function totalsBy<K>(
  sales: readonly LeanSale[],
  key: (sale: LeanSale) => K,
): Map<K, Totals> {
  const map = new Map<K, Totals>();
  for (const sale of sales) {
    const k = key(sale);
    const t = map.get(k) ?? { quantity: 0, revenue: 0, count: 0 };
    t.quantity += sale.quantity;
    t.revenue += sale.quantity * sale.salePrice;
    t.count += 1;
    map.set(k, t);
  }
  return map;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function fromTo(value: unknown): { from: number; to: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const from = finiteNumber((value as { from?: unknown }).from);
  const to = finiteNumber((value as { to?: unknown }).to);
  return from === null || to === null ? null : { from, to };
}

function objectIdOf(value: unknown): Types.ObjectId | null {
  if (value instanceof Types.ObjectId) return value;
  return typeof value === 'string' && Types.ObjectId.isValid(value)
    ? new Types.ObjectId(value)
    : null;
}

/**
 * 1-16D — historique d'un mois pour l'export Excel et PDF.
 *
 * Totaux, classement par produit (gain compris) et classement par vendeur :
 * AGRÉGATIONS DE L'ANALYSE réutilisées telles quelles (`AnalyticsService`),
 * mêmes bornes (`saleMonthMatch`). La liste complète des ventes est lue avec
 * le même filtre, sans pagination ; ses totaux doivent coïncider avec ceux
 * de l'Analyse, sinon tout est relu (une vente a changé entre deux
 * lectures), puis 503 après trois essais.
 */
@Injectable()
export class MonthlyHistoryService {
  constructor(
    private readonly analytics: AnalyticsService,
    @InjectModel(Sale.name) private readonly saleModel: Model<SaleDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Organization.name)
    private readonly organizationModel: Model<OrganizationDocument>,
    @InjectModel(AuditLog.name)
    private readonly auditModel: Model<AuditLogDocument>,
  ) {}

  /**
   * Mois proposés : du mois de création du commerce (ou de sa plus ancienne
   * vente) au mois en cours, avec le nombre de ventes de chacun (mois sans
   * vente compris), compté dans le fuseau des bornes.
   */
  async availableMonths(organizationId: string, now = new Date()) {
    const timeZone = processTimeZone();
    const orgOid = new Types.ObjectId(organizationId);
    const [organization, counts] = await Promise.all([
      this.organizationModel
        .findById(orgOid)
        .select({ createdAt: 1, slug: 1 })
        .lean<{ createdAt?: Date; slug?: string }>()
        .exec(),
      this.saleModel.aggregate<{ _id: string; count: number }>([
        { $match: { organizationId: orgOid } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y-%m',
                date: { $ifNull: ['$occurredAt', '$createdAt'] },
                timezone: timeZone,
              },
            },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);
    const currentMonth = localMonthOf(now);
    const byMonth = new Map(counts.map((c) => [c._id, c.count]));
    const firstCandidates = [
      organization?.createdAt ? localMonthOf(organization.createdAt) : null,
      ...byMonth.keys(),
    ].filter((m): m is string => m !== null && m <= currentMonth);
    const first = firstCandidates.length
      ? firstCandidates.reduce((a, b) => (a < b ? a : b))
      : currentMonth;
    const months: Array<{ month: string; salesCount: number }> = [];
    const cursor = new Date(now.getFullYear(), now.getMonth(), 1);
    while (months.length < MAX_LISTED_MONTHS) {
      const month = localMonthOf(cursor);
      if (month < first) break;
      months.push({ month, salesCount: byMonth.get(month) ?? 0 });
      cursor.setMonth(cursor.getMonth() - 1);
    }
    return {
      timeZone,
      currentMonth,
      organizationSlug: organization?.slug ?? 'commerce',
      months,
    };
  }

  async build(
    context: ResolvedOrganizationContext,
    month: string,
    now = new Date(),
  ): Promise<MonthlyHistory> {
    const orgOid = new Types.ObjectId(context.organizationId);
    const { start, end } = monthBounds(month);
    // Droits ACTUELS (relus par les gardes) : données financières et
    // données acheteur seulement si le compte les voit déjà ailleurs.
    const rights = {
      financials:
        hasPermission(context, 'analytics.read') &&
        hasPermission(context, 'products.view_financials'),
      buyers: hasPermission(context, 'sales.view_all'),
    };

    const [organization, author] = await Promise.all([
      this.organizationModel
        .findById(orgOid)
        .select({ name: 1, slug: 1 })
        .lean<{ name: string; slug: string }>()
        .exec(),
      this.userModel
        .findById(context.userId)
        .select({ name: 1 })
        .lean<{ name?: string }>()
        .exec(),
    ]);

    const snapshot = await this.consistentSnapshot(
      context.organizationId,
      orgOid,
      month,
    );
    const { sales, overview, ranking, sellerRanking } = snapshot;

    const productIds = [...new Set(sales.map((s) => String(s.productId)))];
    const movementsRaw = await this.auditModel
      .find({
        organizationId: orgOid,
        action: { $in: [AuditAction.SALE_UPDATED, AuditAction.SALE_CANCELLED] },
        createdAt: { $gte: start, $lt: end },
      })
      .sort({ createdAt: 1, _id: 1 })
      .lean<
        Array<{
          productId: Types.ObjectId;
          action: AuditAction;
          actorId: Types.ObjectId;
          details?: Record<string, unknown>;
          createdAt: Date;
        }>
      >()
      .exec();
    const movementProductIds = movementsRaw.map((m) => String(m.productId));
    const products = await this.productModel
      .find({
        organizationId: orgOid,
        _id: {
          $in: [...new Set([...productIds, ...movementProductIds])].map(
            (id) => new Types.ObjectId(id),
          ),
        },
      })
      .select({ name: 1, deletedAt: 1 })
      .lean<
        Array<{ _id: Types.ObjectId; name: string; deletedAt: Date | null }>
      >()
      .exec();
    const productById = new Map(products.map((p) => [String(p._id), p]));
    const stateOf = (productId: string): ProductState => {
      const product = productById.get(productId);
      if (!product) return 'deleted';
      return product.deletedAt ? 'trash' : 'available';
    };

    const userIds = [
      ...new Set([
        ...sales.map((s) => String(s.sellerId)),
        ...movementsRaw.map((m) => String(m.actorId)),
      ]),
    ];
    const users = await this.userModel
      .find({ _id: { $in: userIds.map((id) => new Types.ObjectId(id)) } })
      .select({ name: 1 })
      .lean<Array<{ _id: Types.ObjectId; name?: string }>>()
      .exec();
    const userName = new Map(users.map((u) => [String(u._id), u.name ?? null]));

    const saleLines: MonthlyHistorySaleLine[] = sales.map((sale) => {
      const productId = String(sale.productId);
      const recordedName = sale.productName ?? null;
      const currentOrLast =
        productById.get(productId)?.name ?? sale.lastKnownProductName ?? null;
      return {
        date: saleDate(sale),
        recordedName,
        otherName:
          recordedName === null || currentOrLast !== recordedName
            ? currentOrLast
            : null,
        productState: stateOf(productId),
        quantity: sale.quantity,
        unitPrice: sale.salePrice,
        amount: sale.quantity * sale.salePrice,
        sellerName: userName.get(String(sale.sellerId)) ?? null,
        ...(rights.buyers
          ? {
              buyerName: sale.buyerName ?? null,
              buyerContact: sale.buyerContact ?? null,
            }
          : {}),
      };
    });

    const productLines: MonthlyHistoryProductLine[] = ranking
      .map((row) => ({
        name: row.productName ?? null,
        productState: row.productDeleted
          ? ('deleted' as const)
          : stateOf(String(row.productId)),
        quantity: row.totalUnitsSold,
        salesCount: row.transactionCount,
        revenue: row.totalRevenue,
        ...(rights.financials ? { gain: row.netProfit ?? null } : {}),
      }))
      .sort(
        (a, b) =>
          b.quantity - a.quantity ||
          b.revenue - a.revenue ||
          (a.name ?? '').localeCompare(b.name ?? '', 'fr'),
      );

    // Classement vendeurs de l'Analyse (comptes existants), puis les ventes
    // dont le compte vendeur n'existe plus, que l'Analyse écarte (jointure
    // stricte, limite 1-15D) : regroupées sur une ligne, jamais perdues.
    const sellerLines: MonthlyHistorySellerLine[] = sellerRanking.map(
      (row) => ({
        name: row.sellerName ?? null,
        quantity: row.totalUnitsSold,
        salesCount: row.transactionCount,
        revenue: row.totalRevenue,
      }),
    );
    const ranked = new Set(sellerRanking.map((r) => String(r.sellerId)));
    const orphan = sales.filter((s) => !ranked.has(String(s.sellerId)));
    if (orphan.length > 0) {
      sellerLines.push({
        name: null,
        quantity: orphan.reduce((n, s) => n + s.quantity, 0),
        salesCount: orphan.length,
        revenue: orphan.reduce((n, s) => n + s.quantity * s.salePrice, 0),
      });
    }

    const movements = await this.movementLines(
      orgOid,
      movementsRaw,
      productById,
      userName,
    );

    let estimatedGain: number | null | undefined;
    if (rights.financials) {
      estimatedGain = productLines.some((p) => p.gain === null)
        ? null
        : productLines.reduce((n, p) => n + (p.gain ?? 0), 0);
    }

    return {
      organization: {
        name: organization?.name ?? '',
        slug: organization?.slug ?? 'commerce',
      },
      period: {
        month,
        start,
        end,
        timeZone: processTimeZone(),
        isCurrentMonth: month === localMonthOf(now),
      },
      generatedAt: now,
      generatedBy: author?.name ?? null,
      rights,
      summary: {
        revenue: overview.totalRevenue,
        quantity: overview.unitsSold,
        salesCount: overview.totalTransactions,
        productsSold: productLines.length,
        sellers: sellerLines.length,
        ...(rights.financials ? { estimatedGain } : {}),
        corrections: movements.filter((m) => m.kind === 'correction').length,
        cancellations: movements.filter((m) => m.kind === 'cancellation')
          .length,
      },
      sales: saleLines,
      products: productLines,
      sellers: sellerLines,
      movements,
    };
  }

  private async consistentSnapshot(
    organizationId: string,
    orgOid: Types.ObjectId,
    month: string,
  ) {
    for (let attempt = 0; attempt < CONSISTENCY_ATTEMPTS; attempt++) {
      const [sales, overview, ranking, sellerRanking] = await Promise.all([
        this.saleModel
          .find({ organizationId: orgOid, ...saleMonthMatch(month) })
          .select({
            occurredAt: 1,
            createdAt: 1,
            productId: 1,
            productName: 1,
            lastKnownProductName: 1,
            quantity: 1,
            salePrice: 1,
            sellerId: 1,
            buyerName: 1,
            buyerContact: 1,
          })
          .lean<LeanSale[]>()
          .exec(),
        this.analytics.getOverview(
          organizationId,
          month,
        ) as Promise<OverviewRow>,
        this.analytics.getProductsRanking(organizationId, month) as Promise<
          ProductRankingRow[]
        >,
        this.analytics.getSellersRanking(organizationId, month) as Promise<
          SellerRankingRow[]
        >,
      ]);
      if (this.isConsistent(sales, overview, ranking, sellerRanking)) {
        sales.sort(
          (a, b) =>
            saleDate(a).getTime() - saleDate(b).getTime() ||
            a.createdAt.getTime() - b.createdAt.getTime() ||
            String(a._id).localeCompare(String(b._id)),
        );
        return { sales, overview, ranking, sellerRanking };
      }
    }
    throw new ServiceUnavailableException({
      code: REPORT_DATA_CHANGED,
      message:
        'Des ventes ont changé pendant la préparation du rapport. Réessayez.',
    });
  }

  /** Liste des ventes ≡ totaux et classements de l'Analyse. */
  private isConsistent(
    sales: readonly LeanSale[],
    overview: OverviewRow,
    ranking: readonly ProductRankingRow[],
    sellerRanking: readonly SellerRankingRow[],
  ): boolean {
    const all = totalsBy(sales, () => 'all').get('all') ?? {
      quantity: 0,
      revenue: 0,
      count: 0,
    };
    if (
      !sameTotals(all, {
        quantity: overview.unitsSold,
        revenue: overview.totalRevenue,
        count: overview.totalTransactions,
      })
    ) {
      return false;
    }
    const byProduct = totalsBy(sales, (s) => String(s.productId));
    if (byProduct.size !== ranking.length) return false;
    for (const row of ranking) {
      const t = byProduct.get(String(row.productId));
      if (
        !t ||
        !sameTotals(t, {
          quantity: row.totalUnitsSold,
          revenue: row.totalRevenue,
          count: row.transactionCount,
        })
      ) {
        return false;
      }
    }
    const bySeller = totalsBy(sales, (s) => String(s.sellerId));
    for (const row of sellerRanking) {
      const t = bySeller.get(String(row.sellerId));
      if (
        !t ||
        !sameTotals(t, {
          quantity: row.totalUnitsSold,
          revenue: row.totalRevenue,
          count: row.transactionCount,
        })
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Corrections et annulations du mois (date de l'opération). Toutes deux
   * sont journalisées DANS la transaction qui modifie ou supprime la vente :
   * l'entrée existe seulement si l'opération a été validée. Une correction
   * sans changement effectif n'est pas listée.
   */
  private async movementLines(
    orgOid: Types.ObjectId,
    raw: ReadonlyArray<{
      productId: Types.ObjectId;
      action: AuditAction;
      actorId: Types.ObjectId;
      details?: Record<string, unknown>;
      createdAt: Date;
    }>,
    productById: ReadonlyMap<string, { name: string }>,
    userName: ReadonlyMap<string, string | null>,
  ): Promise<MonthlyHistoryMovementLine[]> {
    if (raw.length === 0) return [];
    const saleIds = raw
      .filter((m) => m.action === AuditAction.SALE_UPDATED)
      .map((m) => objectIdOf(m.details?.saleId))
      .filter((id): id is Types.ObjectId => id !== null);
    const missingProducts = [
      ...new Set(raw.map((m) => String(m.productId))),
    ].filter((id) => !productById.has(id));
    const [stillThere, historicNames] = await Promise.all([
      saleIds.length
        ? this.saleModel
            .find({ organizationId: orgOid, _id: { $in: saleIds } })
            .select({ occurredAt: 1, createdAt: 1 })
            .lean<
              Array<{
                _id: Types.ObjectId;
                occurredAt?: Date | null;
                createdAt: Date;
              }>
            >()
            .exec()
        : Promise.resolve([]),
      missingProducts.length
        ? this.saleModel.aggregate<{
            _id: Types.ObjectId;
            lastKnown: string | null;
            latest: { name: string } | null;
          }>([
            {
              $match: {
                organizationId: orgOid,
                productId: {
                  $in: missingProducts.map((id) => new Types.ObjectId(id)),
                },
              },
            },
            {
              $group: {
                _id: '$productId',
                lastKnown: { $max: '$lastKnownProductName' },
                latest: {
                  $max: {
                    $cond: [
                      { $ifNull: ['$productName', false] },
                      { at: '$createdAt', name: '$productName' },
                      null,
                    ],
                  },
                },
              },
            },
          ])
        : Promise.resolve([]),
    ]);
    const saleDateById = new Map(
      stillThere.map((s) => [String(s._id), saleDate(s)]),
    );
    const historicName = new Map<string, string | null>(
      historicNames.map((h): [string, string | null] => [
        String(h._id),
        h.lastKnown ?? h.latest?.name ?? null,
      ]),
    );

    const lines: MonthlyHistoryMovementLine[] = [];
    for (const m of raw) {
      const productId = String(m.productId);
      const product = productById.get(productId);
      const base = {
        date: m.createdAt,
        productName: product?.name ?? historicName.get(productId) ?? null,
        productDeleted: !product,
        actorName: userName.get(String(m.actorId)) ?? null,
      };
      const details = m.details ?? {};
      if (m.action === AuditAction.SALE_UPDATED) {
        const quantity = fromTo(details.quantity);
        const price = fromTo(details.salePrice);
        if (!quantity && !price) continue;
        const saleId = objectIdOf(details.saleId);
        lines.push({
          ...base,
          kind: 'correction',
          saleDate: saleId ? (saleDateById.get(String(saleId)) ?? null) : null,
          quantityBefore: quantity?.from ?? null,
          quantityAfter: quantity?.to ?? null,
          priceBefore: price?.from ?? null,
          priceAfter: price?.to ?? null,
        });
      } else {
        lines.push({
          ...base,
          kind: 'cancellation',
          saleDate: null,
          quantityBefore: finiteNumber(details.quantity),
          quantityAfter: null,
          priceBefore: finiteNumber(details.salePrice),
          priceAfter: null,
        });
      }
    }
    return lines;
  }
}
