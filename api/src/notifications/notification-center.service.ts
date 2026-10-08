import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  AppNotification,
  NotificationDocument,
} from './schemas/notification.schema';
import {
  NotificationPreference,
  NotificationPreferenceDocument,
} from './schemas/notification-preference.schema';
import {
  MonthlyReport,
  MonthlyReportDocument,
} from './schemas/monthly-report.schema';
import { NotificationSignalsService } from './notification-signals.service';
import { expiresAfterRead } from './notification-retention';
import {
  CategoryAccessContext,
  DEFAULT_PUSH_PREFERENCES,
  PREFERENCE_BY_CATEGORY,
  PushCategory,
  PushPreferences,
  accessibleCategories,
  canAccessCategory,
} from '../push/schemas/push-category';
import { PUSH_CLOCK } from '../push/push-runtime';
import type { PushClock } from '../push/push-runtime';
import { NOTIFICATION_TITLE, notificationBody } from '../push/push-messages';
import type { AppLocale } from '../common/i18n/locale';
import type { PushJob } from '../push/schemas/push-job.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { Sale, SaleDocument } from '../sales/schemas/sale.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import {
  SubscriptionPayment,
  SubscriptionPaymentDocument,
  SubscriptionPaymentStatus,
} from '../subscriptions/payments/schemas/subscription-payment.schema';
import { SubscriptionPeriodKind } from '../subscriptions/subscription-terms';

/** Contexte serveur (`OrganizationGuard`), jamais le corps. */
export interface NotificationReaderContext extends CategoryAccessContext {
  userId: string;
  organizationId: string;
  /** 1-16G : langue de la requête du lecteur (textes génériques). */
  locale?: AppLocale;
}

export interface NotificationView {
  id: string;
  category: PushCategory;
  title: string;
  body: string;
  /** Route interne de l'écran concerné. */
  link: string;
  createdAt: Date;
  readAt: Date | null;
}

export interface NotificationPage {
  items: NotificationView[];
  nextCursor: string | null;
}

export const NOTIFICATION_PAGE_MAX = 50;
export const REPORT_UNSOLD_PAGE_MAX = 100;
export const NOTIFICATION_NOT_FOUND = 'NOTIFICATION_NOT_FOUND';

type NotificationRecord = AppNotification & { _id: Types.ObjectId };

const PREFERENCE_KEYS = Object.keys(
  DEFAULT_PUSH_PREFERENCES,
) as (keyof PushPreferences)[];

function completeCategories(
  stored: Partial<PushPreferences> | null | undefined,
): PushPreferences {
  const result = { ...DEFAULT_PUSH_PREFERENCES };
  for (const key of PREFERENCE_KEYS) {
    if (typeof stored?.[key] === 'boolean') result[key] = stored[key];
  }
  return result;
}

function link(n: NotificationRecord): string {
  switch (n.category) {
    case PushCategory.STOCK_DEPLETED:
    case PushCategory.STOCK_LOW:
      return n.productId
        ? `/app/catalog/products/${n.productId.toHexString()}`
        : '/app/catalog';
    case PushCategory.SALE_CREATED:
      return '/app/sales';
    case PushCategory.SUBSCRIPTION_ENDING:
    case PushCategory.PAYMENT_SUCCEEDED:
      return '/app/organization/subscription';
    default:
      return `/app/notifications/${n._id.toHexString()}`;
  }
}

function toView(
  n: NotificationRecord,
  locale: AppLocale = 'fr',
): NotificationView {
  return {
    id: n._id.toHexString(),
    category: n.category,
    title: NOTIFICATION_TITLE,
    body: notificationBody(n.category, n.periodKind, locale),
    link: link(n),
    createdAt: n.eventAt,
    readAt: n.readAt,
  };
}

/**
 * 1-16A.1 — Centre de notifications (indépendant du push).
 *
 * Toute lecture (liste, compteur, ouverture, « tout lire », invendus) est
 * filtrée par les catégories AUTORISÉES À CET INSTANT
 * (`canAccessCategory` sur le rôle et les permissions du contexte serveur)
 * et activées dans les préférences du centre, et exclut les notifications
 * expirées. Une permission retirée masque donc immédiatement les anciennes
 * notifications ; leur détail n'est jamais calculé.
 *
 * Les routes gardent le contrôle commercial par défaut (JWT applicatif et
 * abonnement actif) : aucune lecture en session limitée.
 */
@Injectable()
export class NotificationCenterService {
  constructor(
    @InjectModel(AppNotification.name)
    private readonly notificationModel: Model<NotificationDocument>,
    @InjectModel(NotificationPreference.name)
    private readonly preferenceModel: Model<NotificationPreferenceDocument>,
    @InjectModel(MonthlyReport.name)
    private readonly reportModel: Model<MonthlyReportDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Sale.name) private readonly saleModel: Model<SaleDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPaymentDocument>,
    private readonly signals: NotificationSignalsService,
    @Inject(PUSH_CLOCK) private readonly clock: PushClock,
  ) {}

  // ─── Création (dispatcher, processus HTTP) ────────────────────────────────

  /**
   * Utilisateurs (parmi `userIds`) dont la préférence du centre est active
   * pour `category` (document absent : actif).
   */
  async inAppEnabled(
    organizationId: Types.ObjectId,
    userIds: readonly Types.ObjectId[],
    category: PushCategory,
  ): Promise<Types.ObjectId[]> {
    if (userIds.length === 0) return [];
    const key = PREFERENCE_BY_CATEGORY[category];
    const disabled = await this.preferenceModel
      .find({
        organizationId,
        userId: { $in: userIds },
        [`categories.${key}`]: false,
      })
      .select({ userId: 1 })
      .lean<Array<{ userId: Types.ObjectId }>>()
      .exec();
    const off = new Set(disabled.map((d) => d.userId.toHexString()));
    return userIds.filter((id) => !off.has(id.toHexString()));
  }

  /**
   * Une notification par destinataire et événement (upsert
   * `{eventKey, userId}` : une reprise ne double rien). Signal privé aux
   * seuls destinataires nouvellement notifiés.
   */
  async createFromJob(
    job: PushJob & { _id: Types.ObjectId },
    userIds: readonly Types.ObjectId[],
  ): Promise<number> {
    let created = 0;
    for (const userId of userIds) {
      const result = await this.notificationModel
        .updateOne(
          { eventKey: job.eventKey, userId },
          {
            $setOnInsert: {
              organizationId: job.organizationId,
              category: job.category,
              productId: job.productId ?? null,
              saleId: job.saleId ?? null,
              paymentId: job.paymentId ?? null,
              reportId: job.reportId ?? null,
              coverageEndsAt: job.coverageEndsAt ?? null,
              periodKind: job.periodKind ?? null,
              eventAt: job.eventAt,
              readAt: null,
              expiresAt: null,
            },
          },
          { upsert: true },
        )
        .exec();
      if (result.upsertedCount > 0) {
        created += 1;
        this.signals.changed(
          job.organizationId.toHexString(),
          userId.toHexString(),
        );
      }
    }
    return created;
  }

  // ─── Lecture ──────────────────────────────────────────────────────────────

  private async visibleCategories(
    context: NotificationReaderContext,
  ): Promise<PushCategory[]> {
    const preferences = await this.preferences(context);
    return accessibleCategories(context).filter(
      (c) => preferences[PREFERENCE_BY_CATEGORY[c]],
    );
  }

  private async visibleFilter(context: NotificationReaderContext) {
    const now = this.clock();
    return {
      userId: new Types.ObjectId(context.userId),
      organizationId: new Types.ObjectId(context.organizationId),
      category: { $in: await this.visibleCategories(context) },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    };
  }

  async list(
    context: NotificationReaderContext,
    options: { unreadOnly: boolean; limit: number; before?: string },
  ): Promise<NotificationPage> {
    const limit = Math.min(Math.max(options.limit, 1), NOTIFICATION_PAGE_MAX);
    const filter: Record<string, unknown> = await this.visibleFilter(context);
    if (options.unreadOnly) filter.readAt = null;
    if (options.before) {
      if (!Types.ObjectId.isValid(options.before)) {
        throw new BadRequestException('Curseur invalide.');
      }
      filter._id = { $lt: new Types.ObjectId(options.before) };
    }
    const rows = await this.notificationModel
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean<NotificationRecord[]>()
      .exec();
    const items = rows.slice(0, limit).map((n) => toView(n, context.locale));
    return {
      items,
      nextCursor: rows.length > limit ? items[items.length - 1].id : null,
    };
  }

  async unreadCount(context: NotificationReaderContext): Promise<number> {
    return this.notificationModel
      .countDocuments({ ...(await this.visibleFilter(context)), readAt: null })
      .exec();
  }

  private async findVisible(
    context: NotificationReaderContext,
    id: string,
  ): Promise<NotificationRecord> {
    if (!Types.ObjectId.isValid(id)) throw this.notFound();
    const notification = await this.notificationModel
      .findOne({
        ...(await this.visibleFilter(context)),
        _id: new Types.ObjectId(id),
      })
      .lean<NotificationRecord>()
      .exec();
    if (!notification) throw this.notFound();
    return notification;
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      code: NOTIFICATION_NOT_FOUND,
      message: 'Notification introuvable.',
    });
  }

  /**
   * Lecture explicite : `readAt` fixé à la PREMIÈRE lecture seulement
   * (filtre `readAt: null`), donc `expiresAt` jamais repoussé.
   */
  private async markRecordRead(n: NotificationRecord): Promise<boolean> {
    if (n.readAt) return false;
    const readAt = this.clock();
    const result = await this.notificationModel
      .updateOne(
        { _id: n._id, readAt: null },
        { $set: { readAt, expiresAt: expiresAfterRead(n.category, readAt) } },
      )
      .exec();
    return result.modifiedCount === 1;
  }

  async markRead(
    context: NotificationReaderContext,
    id: string,
  ): Promise<NotificationView> {
    const notification = await this.findVisible(context, id);
    if (await this.markRecordRead(notification)) {
      this.signals.changed(context.organizationId, context.userId);
    }
    return toView(
      (await this.notificationModel
        .findById(notification._id)
        .lean<NotificationRecord>()
        .exec()) ?? notification,
      context.locale,
    );
  }

  /** Consultation explicite : marque lue puis renvoie le détail revalidé. */
  async open(
    context: NotificationReaderContext,
    id: string,
  ): Promise<{ notification: NotificationView; details: unknown }> {
    const notification = await this.markRead(context, id);
    const record = await this.findVisible(context, id);
    return { notification, details: await this.details(context, record) };
  }

  /** « Tout marquer comme lu » : notifications VISIBLES non lues seulement. */
  async readAll(context: NotificationReaderContext): Promise<number> {
    const unread = await this.notificationModel
      .find({ ...(await this.visibleFilter(context)), readAt: null })
      .select({ _id: 1, category: 1, readAt: 1 })
      .lean<NotificationRecord[]>()
      .exec();
    let marked = 0;
    for (const n of unread) {
      if (await this.markRecordRead(n)) marked += 1;
    }
    if (marked > 0) {
      this.signals.changed(context.organizationId, context.userId);
    }
    return marked;
  }

  // ─── Détails (droits ACTUELS) ─────────────────────────────────────────────

  private async details(
    context: NotificationReaderContext,
    n: NotificationRecord,
  ): Promise<unknown> {
    // Double garde : la catégorie est déjà filtrée par `visibleFilter`.
    if (!canAccessCategory(n.category, context)) throw this.notFound();
    const organizationId = new Types.ObjectId(context.organizationId);
    switch (n.category) {
      case PushCategory.STOCK_DEPLETED:
      case PushCategory.STOCK_LOW: {
        const product = await this.productModel
          .findOne({ _id: n.productId, organizationId })
          .select({
            name: 1,
            remainingQuantity: 1,
            initialQuantity: 1,
            deletedAt: 1,
          })
          .lean<{
            name: string;
            remainingQuantity: number;
            initialQuantity: number;
            deletedAt: Date | null;
          }>()
          .exec();
        return product
          ? {
              kind: 'stock',
              productId: n.productId?.toHexString() ?? null,
              productName: product.name,
              remainingQuantity: product.remainingQuantity,
              initialQuantity: product.initialQuantity,
              inTrash: Boolean(product.deletedAt),
            }
          : { kind: 'stock', productId: null, removed: true };
      }
      case PushCategory.SALE_CREATED: {
        const sale = await this.saleModel
          .findOne({ _id: n.saleId, organizationId })
          .lean<{
            productId: Types.ObjectId;
            productName?: string;
            lastKnownProductName?: string;
            quantity: number;
            salePrice: number;
            sellerId: Types.ObjectId;
            occurredAt?: Date | null;
            createdAt: Date;
          }>()
          .exec();
        if (!sale) return { kind: 'sale', cancelled: true };
        const [product, seller] = await Promise.all([
          this.productModel
            .findOne({ _id: sale.productId, organizationId })
            .select({ name: 1 })
            .lean<{ name: string }>()
            .exec(),
          this.userModel
            .findById(sale.sellerId)
            .select({ name: 1 })
            .lean<{ name: string }>()
            .exec(),
        ]);
        return {
          kind: 'sale',
          cancelled: false,
          productName:
            product?.name ??
            sale.lastKnownProductName ??
            sale.productName ??
            null,
          quantity: sale.quantity,
          salePrice: sale.salePrice,
          total: sale.salePrice * sale.quantity,
          sellerName: seller?.name ?? null,
          occurredAt: sale.occurredAt ?? sale.createdAt,
        };
      }
      case PushCategory.SUBSCRIPTION_ENDING:
        return {
          kind: 'subscription-ending',
          coverageEndsAt: n.coverageEndsAt,
          trial: n.periodKind === SubscriptionPeriodKind.TRIAL,
        };
      case PushCategory.PAYMENT_SUCCEEDED: {
        const payment = await this.paymentModel
          .findOne({
            _id: n.paymentId,
            organizationId,
            status: SubscriptionPaymentStatus.SUCCEEDED,
          })
          .select({ term: 1, confirmedAt: 1 })
          .lean<{ term: string; confirmedAt: Date | null }>()
          .exec();
        return {
          kind: 'payment',
          term: payment?.term ?? null,
          confirmedAt: payment?.confirmedAt ?? null,
        };
      }
      case PushCategory.MONTHLY_REPORT:
        return this.reportDetails(n, 0, 20);
      default:
        throw this.notFound();
    }
  }

  private async reportDetails(
    n: NotificationRecord,
    offset: number,
    limit: number,
  ) {
    const report = await this.reportModel
      .findOne({ _id: n.reportId, organizationId: n.organizationId })
      .lean<MonthlyReport>()
      .exec();
    if (!report) return { kind: 'monthly-report', missing: true };
    return {
      kind: 'monthly-report',
      missing: false,
      period: report.period,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      timeZone: report.timeZone,
      computedAt: report.computedAt,
      salesCount: report.salesCount,
      topProducts: report.topProducts.map((p) => ({
        productId: String(p.productId),
        name: p.name,
        deleted: p.deleted,
        units: p.units,
      })),
      sellersOfMonth: report.sellersOfMonth.map((s) => ({
        sellerId: String(s.sellerId),
        name: s.name,
        revenue: s.revenue,
        units: s.units,
      })),
      unsold: {
        total: report.unsoldProducts.length,
        offset,
        items: report.unsoldProducts.slice(offset, offset + limit).map((p) => ({
          productId: String(p.productId),
          name: p.name,
          introducedDuringMonth: p.introducedDuringMonth,
          inTrash: p.inTrash,
        })),
      },
    };
  }

  /** Page des produits sans vente d'un bilan visible. */
  async reportUnsold(
    context: NotificationReaderContext,
    id: string,
    offset: number,
    limit: number,
  ) {
    const n = await this.findVisible(context, id);
    if (n.category !== PushCategory.MONTHLY_REPORT) throw this.notFound();
    const details = await this.reportDetails(
      n,
      Math.max(0, offset),
      Math.min(Math.max(limit, 1), REPORT_UNSOLD_PAGE_MAX),
    );
    return 'unsold' in details
      ? details.unsold
      : { total: 0, offset, items: [] };
  }

  // ─── Préférences du centre ────────────────────────────────────────────────

  async preferences(
    context: Pick<NotificationReaderContext, 'userId' | 'organizationId'>,
  ): Promise<PushPreferences> {
    const doc = await this.preferenceModel
      .findOne({
        userId: new Types.ObjectId(context.userId),
        organizationId: new Types.ObjectId(context.organizationId),
      })
      .lean<{ categories: Partial<PushPreferences> }>()
      .exec();
    return completeCategories(doc?.categories);
  }

  async preferencesView(context: NotificationReaderContext) {
    return {
      categories: await this.preferences(context),
      available: accessibleCategories(context),
    };
  }

  async updatePreferences(
    context: NotificationReaderContext,
    update: Partial<Record<keyof PushPreferences, boolean>>,
  ) {
    const next = { ...(await this.preferences(context)) };
    for (const key of PREFERENCE_KEYS) {
      if (typeof update[key] === 'boolean') next[key] = update[key];
    }
    await this.preferenceModel
      .updateOne(
        {
          userId: new Types.ObjectId(context.userId),
          organizationId: new Types.ObjectId(context.organizationId),
        },
        { $set: { categories: next } },
        { upsert: true, runValidators: true },
      )
      .exec();
    this.signals.changed(context.organizationId, context.userId);
    return { categories: next, available: accessibleCategories(context) };
  }
}
