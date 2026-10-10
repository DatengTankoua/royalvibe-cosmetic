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
import {
  MemberActivityAction,
  MemberActivityEntity,
  memberActivityGroupKey,
  memberActivitySentence,
  memberJoinedSentence,
} from './member-activity';
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
import {
  MembershipStatus,
  OrganizationRole,
  hasPermission,
} from '../organizations/permissions';
import {
  OrganizationMembership,
  OrganizationMembershipDocument,
} from '../organizations/schemas/membership.schema';
import { Section, SectionDocument } from '../sections/schemas/section.schema';
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
/** 1-19A : cibles listées dans le détail d'une activité groupée. */
export const ACTIVITY_TARGETS_DETAIL_MAX = 50;
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

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 11000
  );
}

function link(n: NotificationRecord): string {
  switch (n.category) {
    case PushCategory.MEMBER_JOINED:
      return '/app/organization/members';
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

/**
 * 1-19A : texte des catégories `member-*` construit depuis les noms FIGÉS
 * (lisible après suppression de la cible ou de l'invitation) ; textes
 * génériques inchangés pour les autres catégories.
 */
function body(n: NotificationRecord, locale: AppLocale): string {
  if (n.category === PushCategory.MEMBER_JOINED) {
    return memberJoinedSentence(n.actorName ?? null, locale);
  }
  if (
    n.category === PushCategory.MEMBER_ACTIVITY &&
    n.activityEntity &&
    n.activityAction
  ) {
    return memberActivitySentence(
      {
        actorName: n.actorName ?? null,
        entity: n.activityEntity,
        action: n.activityAction,
        count: n.activityCount ?? 1,
        targets: n.activityTargets ?? [],
      },
      locale,
    );
  }
  return notificationBody(n.category, n.periodKind, locale);
}

function toView(
  n: NotificationRecord,
  locale: AppLocale = 'fr',
): NotificationView {
  return {
    id: n._id.toHexString(),
    category: n.category,
    title: NOTIFICATION_TITLE,
    body: body(n, locale),
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
    @InjectModel(OrganizationMembership.name)
    private readonly membershipModel: Model<OrganizationMembershipDocument>,
    @InjectModel(Section.name)
    private readonly sectionModel: Model<SectionDocument>,
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
    actorName: string | null = null,
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
              actorId: job.actorId ?? null,
              actorName,
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

  /**
   * 1-19A — Activité d'un membre : UNE notification par destinataire et
   * regroupement (même auteur, action, type de cible, fenêtre d'une minute).
   * Chaque action n'est comptée qu'une fois (`activityEventIds`) : une
   * reprise après crash bute sur l'index unique `{eventKey, userId}` et ne
   * compte rien de plus. Une action ajoutée à un regroupement déjà lu le
   * repasse non lu. Renvoie le nombre de notifications créées.
   */
  async createActivityFromJob(
    job: PushJob & { _id: Types.ObjectId },
    userIds: readonly Types.ObjectId[],
    actorName: string | null,
  ): Promise<number> {
    if (!job.activity || !job.actorId) return 0;
    const eventKey = memberActivityGroupKey({
      organizationId: job.organizationId.toHexString(),
      actorId: job.actorId.toHexString(),
      entity: job.activity.entity,
      action: job.activity.action,
      eventAt: job.eventAt,
    });
    const target = {
      id: job.activity.targetId?.toHexString() ?? null,
      name: job.activity.targetName ?? null,
    };
    let created = 0;
    for (const userId of userIds) {
      let result: { upsertedCount: number; modifiedCount: number };
      try {
        result = await this.notificationModel
          .updateOne(
            { eventKey, userId, activityEventIds: { $ne: job._id } },
            {
              $setOnInsert: {
                organizationId: job.organizationId,
                category: PushCategory.MEMBER_ACTIVITY,
                productId: null,
                saleId: null,
                paymentId: null,
                reportId: null,
                coverageEndsAt: null,
                periodKind: null,
                actorId: job.actorId,
                actorName,
                activityEntity: job.activity.entity,
                activityAction: job.activity.action,
              },
              $max: { eventAt: job.eventAt },
              $set: { readAt: null, expiresAt: null },
              $inc: { activityCount: 1 },
              $addToSet: {
                activityEventIds: job._id,
                activityTargets: target,
              },
            },
            { upsert: true },
          )
          .exec();
      } catch (err) {
        // Action déjà comptée dans ce regroupement (reprise) : rien à faire.
        if (isDuplicateKeyError(err)) continue;
        throw err;
      }
      if (result.upsertedCount > 0) created += 1;
      if (result.upsertedCount > 0 || result.modifiedCount > 0) {
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
        // 1-19A : recevoir la notification (`sales.notifications`) ne donne
        // pas accès aux chiffres : quantité et montants exigent
        // `sales.view_all`, comme la liste des ventes.
        const figures = hasPermission(context, 'sales.view_all')
          ? {
              quantity: sale.quantity,
              salePrice: sale.salePrice,
              total: sale.salePrice * sale.quantity,
            }
          : {};
        return {
          kind: 'sale',
          cancelled: false,
          productName:
            product?.name ??
            sale.lastKnownProductName ??
            sale.productName ??
            null,
          ...figures,
          sellerName: seller?.name ?? null,
          occurredAt: sale.occurredAt ?? sale.createdAt,
        };
      }
      case PushCategory.MEMBER_JOINED:
        return this.memberJoinedDetails(n, organizationId);
      case PushCategory.MEMBER_ACTIVITY:
        return this.activityDetails(n, organizationId);
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

  /** 1-19A : nouveau membre (nom figé ; rôle ACTUEL s'il est encore actif). */
  private async memberJoinedDetails(
    n: NotificationRecord,
    organizationId: Types.ObjectId,
  ) {
    const membership = n.actorId
      ? await this.membershipModel
          .findOne({
            organizationId,
            userId: n.actorId,
            status: MembershipStatus.ACTIVE,
          })
          .select({ role: 1 })
          .lean<{ role: OrganizationRole }>()
          .exec()
      : null;
    return {
      kind: 'member-joined',
      memberName: n.actorName ?? null,
      role: membership?.role ?? null,
      active: Boolean(membership),
      occurredAt: n.eventAt,
    };
  }

  /**
   * 1-19A : activité d'un membre (propriétaire seul). Noms FIGÉS ; un lien
   * n'est proposé que si la cible existe encore dans CETTE organisation
   * (jamais de lien cassé après suppression définitive). La page cible
   * applique ensuite ses propres contrôles d'accès.
   */
  private async activityDetails(
    n: NotificationRecord,
    organizationId: Types.ObjectId,
  ) {
    const entity = n.activityEntity ?? null;
    const action = n.activityAction ?? null;
    const all = n.activityTargets ?? [];
    const targets = all.slice(0, ACTIVITY_TARGETS_DETAIL_MAX);
    const live = await this.liveTargets(entity, targets, organizationId);
    const targetLink = (id: string | null): string | null => {
      const state = id ? live.get(id) : undefined;
      if (!id || !state || action === MemberActivityAction.PURGED) return null;
      switch (entity) {
        case MemberActivityEntity.PRODUCT:
          return state.inTrash ? '/app/trash' : `/app/catalog/products/${id}`;
        case MemberActivityEntity.SECTION:
          return state.inTrash ? '/app/trash' : `/app/catalog/${id}`;
        case MemberActivityEntity.SALE:
          return '/app/sales';
        default:
          return null;
      }
    };
    const tracked =
      entity === MemberActivityEntity.PRODUCT ||
      entity === MemberActivityEntity.SECTION ||
      entity === MemberActivityEntity.SALE;
    return {
      kind: 'member-activity',
      actorName: n.actorName ?? null,
      entity,
      action,
      count: n.activityCount ?? 1,
      occurredAt: n.eventAt,
      totalTargets: all.length,
      targets: targets.map((t) => ({
        name: t.name,
        link: targetLink(t.id),
        inTrash: t.id ? (live.get(t.id)?.inTrash ?? false) : false,
        removed: tracked && (!t.id || !live.has(t.id)),
      })),
      link:
        entity === MemberActivityEntity.INVITATION
          ? '/app/organization/invitations'
          : entity === MemberActivityEntity.MEMBER
            ? '/app/organization/members'
            : entity === MemberActivityEntity.BRANDING
              ? '/app/organization/branding'
              : null,
    };
  }

  /** Cibles encore présentes dans l'organisation (corbeille comprise). */
  private async liveTargets(
    entity: MemberActivityEntity | null,
    targets: ReadonlyArray<{ id: string | null }>,
    organizationId: Types.ObjectId,
  ): Promise<Map<string, { inTrash: boolean }>> {
    const live = new Map<string, { inTrash: boolean }>();
    const ids = targets
      .map((t) => t.id)
      .filter((id): id is string => !!id && Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (ids.length === 0) return live;
    type Row = { _id: Types.ObjectId; deletedAt?: Date | null };
    const filter = { _id: { $in: ids }, organizationId };
    let rows: Row[] = [];
    if (entity === MemberActivityEntity.PRODUCT) {
      rows = await this.productModel
        .find(filter)
        .select({ deletedAt: 1 })
        .lean<Row[]>()
        .exec();
    } else if (entity === MemberActivityEntity.SECTION) {
      rows = await this.sectionModel
        .find(filter)
        .select({ deletedAt: 1 })
        .lean<Row[]>()
        .exec();
    } else if (entity === MemberActivityEntity.SALE) {
      rows = await this.saleModel
        .find(filter)
        .select({ _id: 1 })
        .lean<Row[]>()
        .exec();
    }
    for (const row of rows) {
      live.set(row._id.toHexString(), { inTrash: Boolean(row.deletedAt) });
    }
    return live;
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
