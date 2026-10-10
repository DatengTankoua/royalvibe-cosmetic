import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import {
  PushJob,
  PushJobDocument,
  PushJobStatus,
} from './schemas/push-job.schema';
import { PushCategory } from './schemas/push-category';
import { PUSH_CLOCK, PushRuntime } from './push-runtime';
import type { PushClock } from './push-runtime';
import {
  MemberActivityAction,
  MemberActivityEntity,
  snapshotName,
} from '../notifications/member-activity';
import { OrganizationRole } from '../organizations/permissions';

// Session transactionnelle Mongoose (même dérivation que les services
// métier : le driver `mongodb` n'est pas résolvable directement).
type MongooseSession = Awaited<ReturnType<Connection['startSession']>>;

/**
 * 1-16A — Enregistrement des travaux de notification DANS la transaction
 * métier (même session) : validés avec elle, annulés par son rollback.
 * Aucun envoi réseau ici : le dispatcher traite les travaux APRÈS commit.
 *
 * - Inactif (CLI, migrations, tests sans activation) : aucune écriture.
 *   1-16A.1 : actif dans le processus HTTP MÊME si `WEB_PUSH_ENABLED=false`
 *   (le centre de notifications ne dépend pas du push).
 * - Upsert `$setOnInsert` sur `eventKey` unique : un rejeu complet du
 *   callback transactionnel (collision, reprise du driver) ne crée jamais un
 *   second travail, et un événement déjà enregistré n'est jamais modifié.
 */
@Injectable()
export class PushOutboxService {
  private readonly logger = new Logger(PushOutboxService.name);

  constructor(
    @InjectModel(PushJob.name)
    private readonly jobModel: Model<PushJobDocument>,
    private readonly runtime: PushRuntime,
    @Inject(PUSH_CLOCK) private readonly clock: PushClock,
  ) {}

  /**
   * Passage RÉEL d'un stock positif à zéro par l'écriture `trigger`
   * (identifiant stable de l'écriture : vente créée, modification de vente).
   * Un réapprovisionnement suivi d'un nouvel épuisement est une autre
   * écriture, donc un autre événement.
   */
  async stockDepletedInSession(
    session: MongooseSession,
    input: { organizationId: string; productId: string; trigger: string },
  ): Promise<void> {
    await this.record(session, {
      eventKey: `stock-depleted:${input.productId}:${input.trigger}`,
      category: PushCategory.STOCK_DEPLETED,
      organizationId: new Types.ObjectId(input.organizationId),
      productId: new Types.ObjectId(input.productId),
    });
  }

  /**
   * 1-16A.1 — Franchissement de 80 % du stock initial consommé par l'écriture
   * `trigger` (même identifiant stable que la rupture). Jamais enregistré si
   * la même opération atteint zéro : la rupture est alors seule annoncée.
   */
  async stockLowInSession(
    session: MongooseSession,
    input: { organizationId: string; productId: string; trigger: string },
  ): Promise<void> {
    await this.record(session, {
      eventKey: `stock-low:${input.productId}:${input.trigger}`,
      category: PushCategory.STOCK_LOW,
      organizationId: new Types.ObjectId(input.organizationId),
      productId: new Types.ObjectId(input.productId),
    });
  }

  /**
   * 1-16A.1 — Création de vente validée (jamais une modification ni une
   * annulation). Clé `sale-created:<vente>` : un rejeu idempotent (aucune
   * transaction) ou une reprise du callback n'en crée pas d'autre.
   * 1-19A : le vendeur (`actorId`) n'est jamais destinataire.
   */
  async saleCreatedInSession(
    session: MongooseSession,
    input: {
      organizationId: string;
      productId: string;
      saleId: string;
      sellerId?: string;
    },
  ): Promise<void> {
    await this.record(session, {
      eventKey: `sale-created:${input.saleId}`,
      category: PushCategory.SALE_CREATED,
      organizationId: new Types.ObjectId(input.organizationId),
      productId: new Types.ObjectId(input.productId),
      saleId: new Types.ObjectId(input.saleId),
      actorId: input.sellerId ? new Types.ObjectId(input.sellerId) : undefined,
    });
  }

  /**
   * 1-19A — Adhésion réussie par acceptation d'une invitation, dans la
   * transaction d'acceptation (aucun événement si elle est annulée). Clé
   * `member-joined:<membership>` : une reprise du callback n'en crée pas
   * d'autre. Le nouveau membre (`actorId`) n'est jamais destinataire.
   */
  async memberJoinedInSession(
    session: MongooseSession,
    input: {
      organizationId: Types.ObjectId;
      userId: Types.ObjectId;
      membershipId: Types.ObjectId;
    },
  ): Promise<void> {
    await this.record(session, {
      eventKey: `member-joined:${input.membershipId.toHexString()}`,
      category: PushCategory.MEMBER_JOINED,
      organizationId: input.organizationId,
      actorId: input.userId,
    });
  }

  /**
   * 1-19A — Action d'écriture RÉUSSIE d'un membre, annoncée au propriétaire.
   * Appelée APRÈS le succès de l'action (jamais sur un refus ou un échec).
   * Best effort : ne lève jamais (une panne ne transforme pas une action
   * réussie en erreur) ; limite documentée : un arrêt du processus entre
   * l'action et cet enregistrement perd la notification.
   *
   * - propriétaire auteur : rien n'est enregistré (jamais notifié de ses
   *   propres actions) ;
   * - `uniqueKey` : action qui ne peut avoir lieu qu'une fois (suppression
   *   définitive, annulation de vente) → clé stable, un rejeu ne compte
   *   rien de plus ; sinon identifiant propre à l'action.
   */
  async memberActivity(
    actor: { organizationId: string; userId: string; role: OrganizationRole },
    activity: {
      entity: MemberActivityEntity;
      action: MemberActivityAction;
      targetId?: string | null;
      targetName?: string | null;
      uniqueKey?: string;
    },
  ): Promise<void> {
    if (actor.role === OrganizationRole.OWNER) return;
    try {
      const id = activity.uniqueKey ?? new Types.ObjectId().toHexString();
      await this.record(null, {
        eventKey: `member-activity:${activity.entity}:${activity.action}:${id}`,
        category: PushCategory.MEMBER_ACTIVITY,
        organizationId: new Types.ObjectId(actor.organizationId),
        actorId: new Types.ObjectId(actor.userId),
        activity: {
          entity: activity.entity,
          action: activity.action,
          targetId:
            activity.targetId && Types.ObjectId.isValid(activity.targetId)
              ? new Types.ObjectId(activity.targetId)
              : null,
          targetName: snapshotName(activity.targetName),
        },
      });
    } catch {
      this.logger.warn(
        `Activité ${activity.entity}:${activity.action} non enregistrée (best effort).`,
      );
    }
  }

  /** Paiement `succeeded` ET période attribuée dans cette transaction. */
  async paymentSucceededInSession(
    session: MongooseSession,
    input: { organizationId: Types.ObjectId; paymentId: Types.ObjectId },
  ): Promise<void> {
    await this.record(session, {
      eventKey: `payment-succeeded:${input.paymentId.toHexString()}`,
      category: PushCategory.PAYMENT_SUCCEEDED,
      organizationId: input.organizationId,
      paymentId: input.paymentId,
    });
  }

  private async record(
    session: MongooseSession | null,
    job: {
      eventKey: string;
      category: PushCategory;
      organizationId: Types.ObjectId;
      productId?: Types.ObjectId;
      paymentId?: Types.ObjectId;
      saleId?: Types.ObjectId;
      actorId?: Types.ObjectId;
      activity?: {
        entity: MemberActivityEntity;
        action: MemberActivityAction;
        targetId: Types.ObjectId | null;
        targetName: string | null;
      };
    },
  ): Promise<void> {
    if (!this.runtime.active) return;
    await this.jobModel
      .updateOne(
        { eventKey: job.eventKey },
        {
          $setOnInsert: {
            ...job,
            productId: job.productId ?? null,
            paymentId: job.paymentId ?? null,
            saleId: job.saleId ?? null,
            actorId: job.actorId ?? null,
            activity: job.activity ?? null,
            reportId: null,
            coverageEndsAt: null,
            periodKind: null,
            eventAt: this.clock(),
            status: PushJobStatus.PENDING,
            outcome: null,
            deliveries: 0,
            processedAt: null,
          },
        },
        { upsert: true, session: session ?? undefined },
      )
      .exec();
  }
}
