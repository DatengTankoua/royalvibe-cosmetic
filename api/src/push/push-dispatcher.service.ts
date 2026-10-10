import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  PushJob,
  PushJobDocument,
  PushJobStatus,
} from './schemas/push-job.schema';
import {
  PushDelivery,
  PushDeliveryDocument,
  PushDeliveryStatus,
} from './schemas/push-delivery.schema';
import {
  PushSubscriptionDisabledReason,
  PushSubscriptionDocument,
  PushSubscriptionRecord,
  PushSubscriptionStatus,
} from './schemas/push-subscription.schema';
import {
  PREFERENCE_BY_CATEGORY,
  PushCategory,
  canAccessCategory,
} from './schemas/push-category';
import { PUSH_CLOCK, PushRuntime } from './push-runtime';
import type { PushClock } from './push-runtime';
import { buildPushMessage, pushTopic } from './push-messages';
import { recipientLocale } from '../common/i18n/locale';
import type { PushSendResult } from './push-transport';
import { completePreferences } from './push-subscriptions.service';
import { stockLowReached } from './stock-thresholds';
import { User, UserDocument } from '../users/schemas/user.schema';
import {
  Organization,
  OrganizationDocument,
} from '../organizations/schemas/organization.schema';
import {
  OrganizationMembership,
  OrganizationMembershipDocument,
} from '../organizations/schemas/membership.schema';
import {
  DelegablePermission,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
} from '../organizations/permissions';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { Sale, SaleDocument } from '../sales/schemas/sale.schema';
import {
  SubscriptionPayment,
  SubscriptionPaymentDocument,
  SubscriptionPaymentStatus,
} from '../subscriptions/payments/schemas/subscription-payment.schema';
import {
  SubscriptionPeriod,
  SubscriptionPeriodDocument,
} from '../subscriptions/schemas/subscription-period.schema';
import {
  SubscriptionPeriodKind,
  computeSubscriptionState,
} from '../subscriptions/subscription-terms';
import { currentSessionVersion } from '../auth/session-version';
import { NotificationCenterService } from '../notifications/notification-center.service';
import { MonthlyReportService } from '../notifications/monthly-report.service';
import {
  MonthlyReport,
  MonthlyReportDocument,
} from '../notifications/schemas/monthly-report.schema';
import {
  MEMBER_ACTIVITY_ACTOR_NAME_MAX,
  MEMBER_ACTIVITY_WINDOW_MS,
  memberActivityGroupKey,
  snapshotName,
} from '../notifications/member-activity';

/** Rappel d'échéance : à partir de 24 h avant l'échéance effective (UTC). */
export const SUBSCRIPTION_REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Fréquence du balayage des échéances et des bilans mensuels. */
export const SUBSCRIPTION_REMINDER_SCAN_MS = 5 * 60 * 1000;
/** 1-16A.1 : fenêtre FIXE de regroupement des push de ventes. */
export const SALE_DIGEST_WINDOW_MS = 60_000;
/**
 * Durée de pertinence d'un événement POUR LE PUSH : au-delà, il n'est plus
 * envoyé (pas de rafale d'anciens événements après une panne ou une
 * réactivation). La notification du centre, elle, reste créée tant que
 * l'événement est pertinent.
 */
export const PUSH_EVENT_MAX_AGE_MS: Readonly<
  Record<PushCategory, number | null>
> = Object.freeze({
  [PushCategory.STOCK_DEPLETED]: 6 * 60 * 60 * 1000,
  [PushCategory.STOCK_LOW]: 6 * 60 * 60 * 1000,
  [PushCategory.SALE_CREATED]: 60 * 60 * 1000,
  [PushCategory.SALE_DIGEST]: 60 * 60 * 1000,
  [PushCategory.PAYMENT_SUCCEEDED]: 60 * 60 * 1000,
  [PushCategory.MONTHLY_REPORT]: 12 * 60 * 60 * 1000,
  [PushCategory.MEMBER_JOINED]: 60 * 60 * 1000,
  [PushCategory.MEMBER_ACTIVITY]: 60 * 60 * 1000,
  // Pertinent jusqu'à l'échéance visée elle-même.
  [PushCategory.SUBSCRIPTION_ENDING]: null,
});
/** Envois par livraison (premier compris), puis abandon. */
export const PUSH_MAX_ATTEMPTS = 5;
/** Délais avant la reprise n (après l'échec n). */
export const PUSH_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
]);
/** Verrou d'un envoi en cours (repris après expiration : crash). */
export const PUSH_SEND_LOCK_MS = 60_000;
/** Intervalle du traitement de fond (mono-instance). */
export const PUSH_POLL_INTERVAL_MS = 5_000;
const BATCH = 50;

type JobRecord = PushJob & { _id: Types.ObjectId };
type SubscriptionRecord = PushSubscriptionRecord & { _id: Types.ObjectId };
type DeliveryRecord = PushDelivery & { _id: Types.ObjectId };

export interface PushRunSummary {
  reminders: number;
  reports: number;
  jobsDispatched: number;
  jobsCancelled: number;
  notifications: number;
  sent: number;
  retried: number;
  skipped: number;
  failed: number;
}

/**
 * 1-16A / 1-16A.1 — Traitement de fond des notifications (mono-instance).
 *
 * `runOnce()` :
 * 1. balayages périodiques (5 min) : rappels d'échéance, bilans du mois
 *    écoulé ;
 * 2. répartition de chaque événement : notifications du CENTRE (une par
 *    membre autorisé, préférence du centre active), puis, si le push est
 *    actif, livraisons (une par appareil éligible ; ventes regroupées par
 *    fenêtre fixe d'une minute) ;
 * 3. rattrapage des rappels encore pertinents (appareil ou préférence
 *    activés après le rappel) ;
 * 4. envois push.
 * `start()` n'est appelé QUE par le démarrage HTTP (`startNotifications`) :
 * charger `AppModule` ne démarre aucune boucle, aucun minuteur, aucun envoi.
 *
 * Destinataires et droits relus en base (règle unique `canAccessCategory`),
 * à la répartition puis avant CHAQUE envoi : membership active, rôle et
 * permissions actuels, organisation active ; pour un appareil, en plus :
 * actif, même titulaire, préférence, version de session, enregistré avant
 * l'événement (sauf rappel encore pertinent).
 *
 * Une panne push n'affecte jamais les écritures métier (déjà validées).
 * Journalisation : identifiants internes et statut HTTP seuls, jamais
 * l'endpoint, les clés ni la clé privée VAPID.
 */
@Injectable()
export class PushDispatcherService implements OnApplicationShutdown {
  private readonly logger = new Logger(PushDispatcherService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = true;
  private lastReminderScanAt: number | null = null;

  constructor(
    @InjectModel(PushJob.name)
    private readonly jobModel: Model<PushJobDocument>,
    @InjectModel(PushDelivery.name)
    private readonly deliveryModel: Model<PushDeliveryDocument>,
    @InjectModel(PushSubscriptionRecord.name)
    private readonly subscriptionModel: Model<PushSubscriptionDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Organization.name)
    private readonly organizationModel: Model<OrganizationDocument>,
    @InjectModel(OrganizationMembership.name)
    private readonly membershipModel: Model<OrganizationMembershipDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Sale.name) private readonly saleModel: Model<SaleDocument>,
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPaymentDocument>,
    @InjectModel(SubscriptionPeriod.name)
    private readonly periodModel: Model<SubscriptionPeriodDocument>,
    @InjectModel(MonthlyReport.name)
    private readonly reportModel: Model<MonthlyReportDocument>,
    private readonly center: NotificationCenterService,
    private readonly reports: MonthlyReportService,
    private readonly runtime: PushRuntime,
    @Inject(PUSH_CLOCK) private readonly clock: PushClock,
  ) {}

  // ─── Boucle (démarrage HTTP uniquement) ────────────────────────────────────

  start(intervalMs: number = PUSH_POLL_INTERVAL_MS): void {
    if (!this.runtime.active || !this.stopped) return;
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      this.running = this.runOnce()
        .catch(() => this.logger.warn('Passe de notifications interrompue.'))
        .finally(() => {
          this.running = null;
          if (this.stopped) return;
          this.timer = setTimeout(tick, intervalMs);
          this.timer.unref();
        });
    };
    this.timer = setTimeout(tick, 0);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  get started(): boolean {
    return !this.stopped;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  // ─── Passe ─────────────────────────────────────────────────────────────────

  async runOnce(): Promise<PushRunSummary> {
    const summary: PushRunSummary = {
      reminders: 0,
      reports: 0,
      jobsDispatched: 0,
      jobsCancelled: 0,
      notifications: 0,
      sent: 0,
      retried: 0,
      skipped: 0,
      failed: 0,
    };
    if (!this.runtime.active) return summary;
    const now = this.clock().getTime();
    if (
      this.lastReminderScanAt === null ||
      now - this.lastReminderScanAt >= SUBSCRIPTION_REMINDER_SCAN_MS ||
      now < this.lastReminderScanAt
    ) {
      summary.reminders = await this.scanSubscriptionReminders();
      summary.reports = await this.scanMonthlyReports();
      this.lastReminderScanAt = now;
    }
    await this.dispatchJobs(summary);
    await this.catchUpReminders(summary);
    await this.sendDeliveries(summary);
    return summary;
  }

  /**
   * Rappels d'échéance : organisations dont une période se termine dans les
   * 24 h ; le rappel vise l'échéance EFFECTIVE (couverture continue), donc
   * aucun rappel si une période suivante prolonge déjà l'accès. Clé
   * `subscription-ending:<organisation>:<échéance>` : un seul rappel par
   * échéance, même après redémarrage ; une nouvelle échéance (après
   * renouvellement) a sa propre clé.
   */
  async scanSubscriptionReminders(): Promise<number> {
    const now = this.clock();
    const horizon = new Date(now.getTime() + SUBSCRIPTION_REMINDER_WINDOW_MS);
    const organizationIds: Types.ObjectId[] = await this.periodModel
      .distinct('organizationId', { endsAt: { $gt: now, $lte: horizon } })
      .exec();
    let created = 0;
    for (const organizationId of organizationIds) {
      const due = await this.effectiveEnding(organizationId, now);
      if (!due) continue;
      created += await this.recordJob({
        eventKey: `subscription-ending:${organizationId.toHexString()}:${due.endsAt.getTime()}`,
        category: PushCategory.SUBSCRIPTION_ENDING,
        organizationId,
        coverageEndsAt: due.endsAt,
        periodKind: due.kind,
        eventAt: now,
      });
    }
    return created;
  }

  /**
   * 1-16A.1 — Bilans du mois civil écoulé (mois précédent seulement : aucune
   * rafale d'anciens mois), puis un événement par bilan (clé
   * `monthly-report:<organisation>:<AAAA-MM>`, idempotente : reprise après
   * redémarrage ou crash entre le bilan et l'événement).
   */
  async scanMonthlyReports(): Promise<number> {
    const now = this.clock();
    const due = await this.reports.generateDue(now);
    if (due.length === 0) return 0;
    const keys = due.map(
      (r) => `monthly-report:${r.organizationId.toHexString()}:${r.period}`,
    );
    const existing = new Set(
      (
        await this.jobModel
          .find({ eventKey: { $in: keys } })
          .select({ eventKey: 1 })
          .lean<Array<{ eventKey: string }>>()
          .exec()
      ).map((j) => j.eventKey),
    );
    let created = 0;
    for (const [i, report] of due.entries()) {
      if (existing.has(keys[i])) continue;
      created += await this.recordJob({
        eventKey: keys[i],
        category: PushCategory.MONTHLY_REPORT,
        organizationId: report.organizationId,
        reportId: report.reportId,
        eventAt: now,
      });
    }
    return created;
  }

  private async recordJob(job: {
    eventKey: string;
    category: PushCategory;
    organizationId: Types.ObjectId;
    eventAt: Date;
    coverageEndsAt?: Date;
    periodKind?: SubscriptionPeriodKind;
    reportId?: Types.ObjectId;
    actorId?: Types.ObjectId;
    status?: PushJobStatus;
  }): Promise<number> {
    const result = await this.jobModel
      .updateOne(
        { eventKey: job.eventKey },
        {
          $setOnInsert: {
            category: job.category,
            organizationId: job.organizationId,
            productId: null,
            paymentId: null,
            saleId: null,
            actorId: job.actorId ?? null,
            activity: null,
            reportId: job.reportId ?? null,
            coverageEndsAt: job.coverageEndsAt ?? null,
            periodKind: job.periodKind ?? null,
            eventAt: job.eventAt,
            status: job.status ?? PushJobStatus.PENDING,
            outcome: null,
            deliveries: 0,
            processedAt: null,
          },
        },
        { upsert: true },
      )
      .exec();
    return result.upsertedCount;
  }

  /** Échéance effective dans la fenêtre de rappel, sinon `null`. */
  private async effectiveEnding(
    organizationId: Types.ObjectId,
    now: Date,
  ): Promise<{ endsAt: Date; kind: SubscriptionPeriodKind } | null> {
    const periods = await this.periodModel
      .find({ organizationId })
      .select({ sequence: 1, kind: 1, term: 1, startsAt: 1, endsAt: 1 })
      .lean()
      .exec();
    const state = computeSubscriptionState(periods, now);
    const endsAt = state.coverageEndsAt;
    if (state.state !== 'active' || !endsAt) return null;
    const remaining = endsAt.getTime() - now.getTime();
    if (remaining <= 0 || remaining > SUBSCRIPTION_REMINDER_WINDOW_MS) {
      return null;
    }
    const last = periods.find((p) => p.endsAt.getTime() === endsAt.getTime());
    return { endsAt, kind: last?.kind ?? SubscriptionPeriodKind.SUBSCRIPTION };
  }

  // ─── Répartition ───────────────────────────────────────────────────────────

  private async dispatchJobs(summary: PushRunSummary): Promise<void> {
    const jobs = await this.jobModel
      .find({ status: PushJobStatus.PENDING })
      .sort({ eventAt: 1 })
      .limit(BATCH)
      .lean<JobRecord[]>()
      .exec();
    for (const job of jobs) {
      const now = this.clock();
      const irrelevance = await this.irrelevance(job, now);
      if (irrelevance) {
        await this.closeJob(job._id, PushJobStatus.CANCELLED, irrelevance, 0);
        summary.jobsCancelled += 1;
        continue;
      }
      const members = await this.eligibleMembers(job);
      // Centre : indépendant du push et de ses délais.
      const recipients = await this.center.inAppEnabled(
        job.organizationId,
        members,
        job.category,
      );
      summary.notifications +=
        job.category === PushCategory.MEMBER_ACTIVITY
          ? await this.center.createActivityFromJob(
              job,
              recipients,
              await this.actorName(job),
            )
          : await this.center.createFromJob(
              job,
              recipients,
              job.category === PushCategory.MEMBER_JOINED
                ? await this.actorName(job)
                : null,
            );
      let deliveries = 0;
      let outcome: string | null = null;
      if (!this.runtime.pushActive) {
        outcome = 'push-disabled';
      } else if (this.pushExpired(job, now)) {
        outcome = 'push-expired';
      } else {
        deliveries = await this.planDeliveries(job, members, now);
      }
      await this.closeJob(
        job._id,
        PushJobStatus.DISPATCHED,
        outcome,
        deliveries,
      );
      summary.jobsDispatched += 1;
    }
  }

  /** Livraisons d'un événement (regroupées pour les ventes). */
  private async planDeliveries(
    job: JobRecord,
    members: readonly Types.ObjectId[],
    now: Date,
  ): Promise<number> {
    const devices = await this.eligibleDevices(job, members);
    if (devices.length === 0) return 0;
    let target = job;
    let nextAttemptAt = now;
    if (job.category === PushCategory.SALE_CREATED) {
      target = await this.saleDigest(job);
      nextAttemptAt = new Date(target.eventAt.getTime());
    } else if (job.category === PushCategory.MEMBER_ACTIVITY) {
      target = await this.activityGroup(job);
      nextAttemptAt = new Date(target.eventAt.getTime());
    }
    for (const subscription of devices) {
      await this.upsertDelivery(target, subscription, nextAttemptAt);
    }
    return devices.length;
  }

  /**
   * 1-16A.1 — Événement push de regroupement des ventes : fenêtre FIXE d'une
   * minute alignée sur l'heure de la vente ; une seule livraison par appareil
   * et par fenêtre, envoyée à la fin de la fenêtre. Chaque vente garde sa
   * notification individuelle dans le centre.
   */
  private async saleDigest(sale: JobRecord): Promise<JobRecord> {
    const windowStart =
      Math.floor(sale.eventAt.getTime() / SALE_DIGEST_WINDOW_MS) *
      SALE_DIGEST_WINDOW_MS;
    const eventKey = `sale-digest:${sale.organizationId.toHexString()}:${windowStart}`;
    await this.recordJob({
      eventKey,
      category: PushCategory.SALE_DIGEST,
      organizationId: sale.organizationId,
      // Fin de fenêtre : heure d'envoi et référence de pertinence.
      eventAt: new Date(windowStart + SALE_DIGEST_WINDOW_MS),
      status: PushJobStatus.DISPATCHED,
    });
    const digest = await this.jobModel
      .findOne({ eventKey })
      .lean<JobRecord>()
      .exec();
    if (!digest) throw new Error('Sale digest vanished');
    return digest;
  }

  /**
   * 1-19A — Événement push de regroupement des activités : même auteur,
   * action et type de cible sur une fenêtre FIXE d'une minute ; une seule
   * livraison par appareil, envoyée en fin de fenêtre (une action groupée
   * de la corbeille ne produit pas un push par produit).
   */
  private async activityGroup(job: JobRecord): Promise<JobRecord> {
    if (!job.activity || !job.actorId) return job;
    const eventKey = memberActivityGroupKey({
      organizationId: job.organizationId.toHexString(),
      actorId: job.actorId.toHexString(),
      entity: job.activity.entity,
      action: job.activity.action,
      eventAt: job.eventAt,
    });
    const windowEnd =
      Number(eventKey.slice(eventKey.lastIndexOf(':') + 1)) +
      MEMBER_ACTIVITY_WINDOW_MS;
    await this.recordJob({
      eventKey,
      category: PushCategory.MEMBER_ACTIVITY,
      organizationId: job.organizationId,
      actorId: job.actorId,
      eventAt: new Date(windowEnd),
      status: PushJobStatus.DISPATCHED,
    });
    const group = await this.jobModel
      .findOne({ eventKey })
      .lean<JobRecord>()
      .exec();
    if (!group) throw new Error('Activity group vanished');
    return group;
  }

  /** 1-19A : nom de l'auteur, figé dans la notification du centre. */
  private async actorName(job: JobRecord): Promise<string | null> {
    if (!job.actorId) return null;
    const user = await this.userModel
      .findById(job.actorId)
      .select({ name: 1 })
      .lean<{ name?: string }>()
      .exec();
    return snapshotName(user?.name, MEMBER_ACTIVITY_ACTOR_NAME_MAX);
  }

  private async upsertDelivery(
    job: JobRecord,
    subscription: SubscriptionRecord,
    nextAttemptAt: Date,
  ): Promise<boolean> {
    // Upsert : une reprise après crash ne double aucune livraison.
    const result = await this.deliveryModel
      .updateOne(
        { jobId: job._id, subscriptionId: subscription._id },
        {
          $setOnInsert: {
            userId: subscription.userId,
            organizationId: job.organizationId,
            status: PushDeliveryStatus.PENDING,
            attempts: 0,
            nextAttemptAt,
            lockedUntil: null,
            lastResult: null,
            sentAt: null,
          },
        },
        { upsert: true },
      )
      .exec();
    return result.upsertedCount > 0;
  }

  private async closeJob(
    jobId: Types.ObjectId,
    status: PushJobStatus,
    outcome: string | null,
    deliveries: number,
  ): Promise<void> {
    await this.jobModel
      .updateOne(
        { _id: jobId, status: PushJobStatus.PENDING },
        { $set: { status, outcome, deliveries, processedAt: this.clock() } },
      )
      .exec();
  }

  private pushExpired(job: JobRecord, now: Date): boolean {
    const maxAge = PUSH_EVENT_MAX_AGE_MS[job.category];
    return maxAge !== null && now.getTime() - job.eventAt.getTime() > maxAge;
  }

  /**
   * 1-19A : auteur de l'événement, jamais destinataire. Ancien travail de
   * vente sans `actorId` : vendeur relu sur la vente.
   */
  private async eventActor(job: JobRecord): Promise<Types.ObjectId | null> {
    if (job.actorId) return job.actorId;
    if (job.category !== PushCategory.SALE_CREATED || !job.saleId) return null;
    const sale = await this.saleModel
      .findOne({ _id: job.saleId, organizationId: job.organizationId })
      .select({ sellerId: 1 })
      .lean<{ sellerId: Types.ObjectId }>()
      .exec();
    return sale?.sellerId ?? null;
  }

  /**
   * Membres actifs autorisés à cet instant (règle unique), hors auteur de
   * l'événement (1-19A), sans doublon (une membership par utilisateur et
   * organisation, index unique).
   */
  private async eligibleMembers(job: JobRecord): Promise<Types.ObjectId[]> {
    const actor = await this.eventActor(job);
    const memberships = await this.membershipModel
      .find({
        organizationId: job.organizationId,
        status: MembershipStatus.ACTIVE,
      })
      .select({ userId: 1, role: 1, permissions: 1 })
      .lean<
        Array<{
          userId: Types.ObjectId;
          role: OrganizationRole;
          permissions: DelegablePermission[];
        }>
      >()
      .exec();
    const allowed = memberships.filter(
      (m) =>
        !(actor && m.userId.equals(actor)) &&
        canAccessCategory(job.category, {
          role: m.role,
          permissions: m.permissions ?? [],
        }),
    );
    if (allowed.length === 0) return [];
    const existing = await this.userModel
      .find({ _id: { $in: allowed.map((m) => m.userId) } })
      .select({ _id: 1 })
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    return existing.map((u) => u._id);
  }

  /** Appareils éligibles des membres autorisés. */
  private async eligibleDevices(
    job: JobRecord,
    members: readonly Types.ObjectId[],
  ): Promise<SubscriptionRecord[]> {
    if (members.length === 0) return [];
    const candidates = await this.subscriptionModel
      .find({
        organizationId: job.organizationId,
        userId: { $in: members },
        status: PushSubscriptionStatus.ACTIVE,
      })
      .lean<SubscriptionRecord[]>()
      .exec();
    const eligible: SubscriptionRecord[] = [];
    for (const subscription of candidates) {
      if ((await this.deviceIssue(job, subscription)) === null) {
        eligible.push(subscription);
      }
    }
    return eligible;
  }

  /**
   * 1-16A.1 — Rappels encore pertinents (échéance future, échéance effective
   * inchangée) : un appareil ou une préférence activés APRÈS le rappel le
   * reçoivent encore, et la notification du centre est créée si elle manque
   * (préférence du centre réactivée). Unicité : aucune seconde livraison ni
   * notification.
   */
  private async catchUpReminders(summary: PushRunSummary): Promise<void> {
    const now = this.clock();
    const reminders = await this.jobModel
      .find({
        category: PushCategory.SUBSCRIPTION_ENDING,
        status: PushJobStatus.DISPATCHED,
        coverageEndsAt: { $gt: now },
      })
      .limit(BATCH)
      .lean<JobRecord[]>()
      .exec();
    for (const job of reminders) {
      if (await this.irrelevance(job, now)) continue;
      const members = await this.eligibleMembers(job);
      summary.notifications += await this.center.createFromJob(
        job,
        await this.center.inAppEnabled(
          job.organizationId,
          members,
          job.category,
        ),
      );
      if (!this.runtime.pushActive) continue;
      for (const subscription of await this.eligibleDevices(job, members)) {
        await this.upsertDelivery(job, subscription, now);
      }
    }
  }

  // ─── Envois ────────────────────────────────────────────────────────────────

  private async sendDeliveries(summary: PushRunSummary): Promise<void> {
    if (!this.runtime.pushActive) return;
    const now = this.clock();
    const due = await this.deliveryModel
      .find({
        $or: [
          { status: PushDeliveryStatus.PENDING, nextAttemptAt: { $lte: now } },
          // Envoi interrompu (crash) : repris après expiration du verrou.
          { status: PushDeliveryStatus.SENDING, lockedUntil: { $lte: now } },
        ],
      })
      .sort({ nextAttemptAt: 1 })
      .limit(BATCH)
      .select({ _id: 1 })
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    for (const { _id } of due) {
      await this.sendOne(_id, summary);
    }
  }

  private async sendOne(
    deliveryId: Types.ObjectId,
    summary: PushRunSummary,
  ): Promise<void> {
    const now = this.clock();
    // Réservation conditionnelle : une seule passe envoie une livraison.
    const delivery = await this.deliveryModel
      .findOneAndUpdate(
        {
          _id: deliveryId,
          $or: [
            {
              status: PushDeliveryStatus.PENDING,
              nextAttemptAt: { $lte: now },
            },
            { status: PushDeliveryStatus.SENDING, lockedUntil: { $lte: now } },
          ],
        },
        {
          $set: {
            status: PushDeliveryStatus.SENDING,
            lockedUntil: new Date(now.getTime() + PUSH_SEND_LOCK_MS),
          },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after' },
      )
      .lean<DeliveryRecord>()
      .exec();
    if (!delivery) return;

    const job = await this.jobModel
      .findById(delivery.jobId)
      .lean<JobRecord>()
      .exec();
    const subscription = await this.subscriptionModel
      .findById(delivery.subscriptionId)
      .lean<SubscriptionRecord>()
      .exec();
    const transport = this.runtime.transport;
    const issue = !job
      ? 'job-missing'
      : !subscription
        ? 'subscription-missing'
        : !transport
          ? 'inactive'
          : this.pushExpired(job, now)
            ? 'expired'
            : ((await this.irrelevance(job, now)) ??
              (await this.deviceIssue(job, subscription, delivery)));
    if (issue || !job || !subscription || !transport) {
      await this.finish(delivery._id, PushDeliveryStatus.SKIPPED, issue);
      summary.skipped += 1;
      return;
    }

    // 1-16G : langue du titulaire de l'appareil (repli français).
    const recipient = await this.userModel
      .findById(subscription.userId)
      .select('locale')
      .lean<{ locale?: unknown }>()
      .exec();
    const message = buildPushMessage(
      {
        category: job.category,
        organizationId: job.organizationId.toHexString(),
        productId: job.productId?.toHexString() ?? null,
        paymentId: job.paymentId?.toHexString() ?? null,
        saleId: job.saleId?.toHexString() ?? null,
        reportId: job.reportId?.toHexString() ?? null,
        periodKind: job.periodKind,
        eventKey: job.eventKey,
      },
      {
        userId: subscription.userId.toHexString(),
        organizationId: subscription.organizationId.toHexString(),
        locale: recipientLocale(recipient?.locale),
      },
    );
    // Un transport qui rejette est traité comme une panne réseau (reprise
    // bornée) : jamais une exception remontant au traitement de fond.
    const result = await transport
      .send(
        {
          endpoint: subscription.endpoint,
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        },
        JSON.stringify(message),
        {
          ttlSeconds: this.ttlSeconds(job, now),
          topic: pushTopic(message.tag),
        },
      )
      .catch((): PushSendResult => ({ statusCode: null, error: 'transport' }));
    const code = result.statusCode;
    const label = code === null ? (result.error ?? 'network') : String(code);

    if (code !== null && code >= 200 && code < 300) {
      await this.finish(delivery._id, PushDeliveryStatus.SENT, label, now);
      await this.subscriptionModel
        .updateOne(
          { _id: subscription._id },
          { $set: { lastDeliveredAt: now } },
        )
        .exec();
      summary.sent += 1;
      return;
    }
    if (code === 404 || code === 410) {
      // Abonnement expiré ou retiré côté navigateur : désactivé.
      await this.disableSubscription(
        subscription._id,
        PushSubscriptionDisabledReason.GONE,
      );
      await this.finish(delivery._id, PushDeliveryStatus.FAILED, label);
      summary.failed += 1;
      this.logger.log(
        `Livraison ${delivery._id.toHexString()} : abonnement disparu (${label}), désactivé.`,
      );
      return;
    }
    const transient = code === null || code === 429 || code >= 500;
    if (transient && delivery.attempts < PUSH_MAX_ATTEMPTS) {
      const delay =
        PUSH_RETRY_DELAYS_MS[
          Math.min(delivery.attempts - 1, PUSH_RETRY_DELAYS_MS.length - 1)
        ];
      await this.deliveryModel
        .updateOne(
          { _id: delivery._id, status: PushDeliveryStatus.SENDING },
          {
            $set: {
              status: PushDeliveryStatus.PENDING,
              nextAttemptAt: new Date(now.getTime() + delay),
              lockedUntil: null,
              lastResult: label,
            },
          },
        )
        .exec();
      summary.retried += 1;
      return;
    }
    await this.finish(delivery._id, PushDeliveryStatus.FAILED, label);
    summary.failed += 1;
    this.logger.warn(
      `Livraison ${delivery._id.toHexString()} abandonnée (${label}).`,
    );
  }

  private async finish(
    deliveryId: Types.ObjectId,
    status: PushDeliveryStatus,
    lastResult: string | null,
    sentAt: Date | null = null,
  ): Promise<void> {
    await this.deliveryModel
      .updateOne(
        { _id: deliveryId, status: PushDeliveryStatus.SENDING },
        { $set: { status, lastResult, lockedUntil: null, sentAt } },
      )
      .exec();
  }

  private async disableSubscription(
    subscriptionId: Types.ObjectId,
    reason: PushSubscriptionDisabledReason,
  ): Promise<void> {
    await this.subscriptionModel
      .updateOne(
        { _id: subscriptionId, status: PushSubscriptionStatus.ACTIVE },
        {
          $set: {
            status: PushSubscriptionStatus.DISABLED,
            disabledReason: reason,
            disabledAt: this.clock(),
          },
        },
      )
      .exec();
  }

  /** Conservation par le service push : jamais au-delà de la pertinence. */
  private ttlSeconds(job: JobRecord, now: Date): number {
    const maxAge = PUSH_EVENT_MAX_AGE_MS[job.category];
    const until =
      maxAge !== null
        ? job.eventAt.getTime() + maxAge
        : (job.coverageEndsAt?.getTime() ?? now.getTime());
    return Math.max(60, Math.floor((until - now.getTime()) / 1000));
  }

  // ─── Revalidations ─────────────────────────────────────────────────────────

  /**
   * Raison pour laquelle l'événement n'est plus à annoncer (ni dans le
   * centre, ni par push), sinon `null`. Le délai de pertinence du push est
   * vérifié à part (`pushExpired`).
   */
  private async irrelevance(job: JobRecord, now: Date): Promise<string | null> {
    const organization = await this.organizationModel
      .findById(job.organizationId)
      .select({ status: 1 })
      .lean<{ status: OrganizationStatus }>()
      .exec();
    if (organization?.status !== OrganizationStatus.ACTIVE) {
      return 'organization-inactive';
    }
    switch (job.category) {
      case PushCategory.STOCK_DEPLETED:
      case PushCategory.STOCK_LOW: {
        const product = await this.productModel
          .findOne({ _id: job.productId, organizationId: job.organizationId })
          .select({ remainingQuantity: 1, initialQuantity: 1, deletedAt: 1 })
          .lean<{
            remainingQuantity: number;
            initialQuantity: number;
            deletedAt: Date | null;
          }>()
          .exec();
        if (!product || product.deletedAt) return 'product-removed';
        if (job.category === PushCategory.STOCK_DEPLETED) {
          if (product.remainingQuantity > 0) return 'restocked';
        } else {
          // Épuisé entre-temps : l'alerte de rupture prend le relais.
          if (product.remainingQuantity <= 0) return 'depleted';
          if (
            !stockLowReached(product.initialQuantity, product.remainingQuantity)
          ) {
            return 'restocked';
          }
        }
        // Un franchissement plus récent du même produit porte sa propre alerte.
        const newer = await this.jobModel
          .exists({
            productId: job.productId,
            category: job.category,
            _id: { $ne: job._id },
            $or: [
              { eventAt: { $gt: job.eventAt } },
              { eventAt: job.eventAt, _id: { $gt: job._id } },
            ],
          })
          .exec();
        return newer ? 'superseded' : null;
      }
      case PushCategory.SALE_CREATED: {
        const sale = await this.saleModel
          .exists({ _id: job.saleId, organizationId: job.organizationId })
          .exec();
        return sale ? null : 'sale-cancelled';
      }
      // 1-19A : adhésion validée et action réussie sont des faits accomplis.
      case PushCategory.SALE_DIGEST:
      case PushCategory.MEMBER_JOINED:
      case PushCategory.MEMBER_ACTIVITY:
        return null;
      case PushCategory.PAYMENT_SUCCEEDED: {
        const payment = await this.paymentModel
          .findOne({ _id: job.paymentId, organizationId: job.organizationId })
          .select({ status: 1, periodId: 1 })
          .lean<{
            status: SubscriptionPaymentStatus;
            periodId: Types.ObjectId | null;
          }>()
          .exec();
        return payment?.status === SubscriptionPaymentStatus.SUCCEEDED &&
          payment.periodId
          ? null
          : 'not-succeeded';
      }
      case PushCategory.SUBSCRIPTION_ENDING: {
        if (!job.coverageEndsAt || now >= job.coverageEndsAt) return 'expired';
        const due = await this.effectiveEnding(job.organizationId, now);
        return due?.endsAt.getTime() === job.coverageEndsAt.getTime()
          ? null
          : 'renewed';
      }
      case PushCategory.MONTHLY_REPORT: {
        const report = await this.reportModel
          .exists({ _id: job.reportId, organizationId: job.organizationId })
          .exec();
        return report ? null : 'report-missing';
      }
    }
  }

  /**
   * Raison pour laquelle cet appareil ne doit pas recevoir l'événement,
   * sinon `null`. Tout est relu en base (jamais un rôle figé).
   */
  private async deviceIssue(
    job: JobRecord,
    subscription: SubscriptionRecord,
    delivery?: DeliveryRecord,
  ): Promise<string | null> {
    if (subscription.status !== PushSubscriptionStatus.ACTIVE) {
      return 'subscription-disabled';
    }
    if (!subscription.organizationId.equals(job.organizationId)) {
      return 'subscription-reassigned';
    }
    if (delivery && !subscription.userId.equals(delivery.userId)) {
      return 'subscription-reassigned';
    }
    const preferences = completePreferences(subscription.preferences);
    if (!preferences[PREFERENCE_BY_CATEGORY[job.category]]) {
      return 'preference-off';
    }
    // Appareil activé après l'événement : rien d'antérieur ne lui est livré,
    // sauf un rappel d'échéance encore pertinent.
    if (
      job.category !== PushCategory.SUBSCRIPTION_ENDING &&
      subscription.registeredAt.getTime() > job.eventAt.getTime()
    ) {
      return 'registered-after-event';
    }
    const user = await this.userModel
      .findById(subscription.userId)
      .select({ authVersion: 1 })
      .lean<{ authVersion?: number | null }>()
      .exec();
    if (!user) return 'user-missing';
    if (currentSessionVersion(user) !== subscription.authVersion) {
      await this.disableSubscription(
        subscription._id,
        PushSubscriptionDisabledReason.SESSION_REVOKED,
      );
      return 'session-revoked';
    }
    const membership = await this.membershipModel
      .findOne({
        organizationId: job.organizationId,
        userId: subscription.userId,
        status: MembershipStatus.ACTIVE,
      })
      .select({ role: 1, permissions: 1 })
      .lean<{ role: OrganizationRole; permissions: DelegablePermission[] }>()
      .exec();
    if (!membership) return 'membership-inactive';
    return canAccessCategory(job.category, {
      role: membership.role,
      permissions: membership.permissions ?? [],
    })
      ? null
      : job.category === PushCategory.STOCK_DEPLETED ||
          job.category === PushCategory.STOCK_LOW
        ? 'permission-missing'
        : 'not-authorized';
  }
}
