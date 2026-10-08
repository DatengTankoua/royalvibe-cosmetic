import { Inject, Injectable } from '@nestjs/common';
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
   */
  async saleCreatedInSession(
    session: MongooseSession,
    input: { organizationId: string; productId: string; saleId: string },
  ): Promise<void> {
    await this.record(session, {
      eventKey: `sale-created:${input.saleId}`,
      category: PushCategory.SALE_CREATED,
      organizationId: new Types.ObjectId(input.organizationId),
      productId: new Types.ObjectId(input.productId),
      saleId: new Types.ObjectId(input.saleId),
    });
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
    session: MongooseSession,
    job: {
      eventKey: string;
      category: PushCategory;
      organizationId: Types.ObjectId;
      productId?: Types.ObjectId;
      paymentId?: Types.ObjectId;
      saleId?: Types.ObjectId;
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
        { upsert: true, session },
      )
      .exec();
  }
}
