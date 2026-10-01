import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import {
  Organization,
  OrganizationDocument,
} from '../organizations/schemas/organization.schema';
import {
  SubscriptionPeriod,
  SubscriptionPeriodDocument,
} from './schemas/subscription-period.schema';
import {
  SUBSCRIPTION_GRANTOR_MAX_LENGTH,
  SUBSCRIPTION_REFERENCE_MAX_LENGTH,
  SubscriptionPeriodKind,
  SubscriptionSource,
  SubscriptionStateView,
  SubscriptionTerm,
  TRIAL_GRANTOR,
  computeRenewalStartsAt,
  computeSubscriptionEndsAt,
  computeSubscriptionState,
  computeTrialEndsAt,
  isSubscriptionTerm,
  trialSourceReference,
} from './subscription-terms';
import { subscriptionDuplicateKeyIndex } from './subscription-period-indexes';
import { SUBSCRIPTION_CLOCK } from './subscription-clock';
import type { SubscriptionClock } from './subscription-clock';

type MongooseSession = Awaited<ReturnType<Connection['startSession']>>;

/** Reprises bornées après collision de chaînage (attributions concurrentes). */
export const MAX_GRANT_ATTEMPTS = 5;

export type SubscriptionGrantErrorCode =
  | 'INVALID_INPUT'
  | 'ORGANIZATION_NOT_FOUND'
  | 'SUBSCRIPTION_REFERENCE_CONFLICT'
  | 'TRIAL_ALREADY_GRANTED'
  | 'GRANT_CONTENTION';

/** Erreur métier d'attribution (CLI / code serveur), jamais une réponse HTTP. */
export class SubscriptionGrantError extends Error {
  constructor(
    readonly code: SubscriptionGrantErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SubscriptionGrantError';
  }
}

export interface GrantSubscriptionInput {
  organizationId: string;
  term: string;
  sourceReference: string;
  grantedBy: string;
}

export interface GrantedPeriodView {
  periodId: string;
  organizationId: string;
  sequence: number;
  term: SubscriptionTerm;
  startsAt: Date;
  endsAt: Date;
  /** `true` : rejeu d'une référence déjà appliquée, aucune durée ajoutée. */
  replayed: boolean;
}

const isStrictObjectId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value);

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null;
}

/**
 * 1-14B — Socle d'abonnement par organisation.
 *
 * - Essai : attribué UNIQUEMENT dans la transaction de création de
 *   l'organisation (`grantTrial`, session de l'appelant).
 * - Abonnement : `grantSubscription`, appelé par le code serveur et le script
 *   CLI, JAMAIS par une route HTTP. Dates calculées ici, jamais fournies.
 * - Lecture : `getState`, à l'heure serveur, sans cron.
 *
 * N'écrit JAMAIS `Organization` : la suspension administrative reste
 * indépendante de l'état commercial.
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    @InjectModel(SubscriptionPeriod.name)
    private periodModel: Model<SubscriptionPeriodDocument>,
    @InjectModel(Organization.name)
    private organizationModel: Model<OrganizationDocument>,
    @InjectConnection() private connection: Connection,
    @Inject(SUBSCRIPTION_CLOCK) private clock: SubscriptionClock,
  ) {}

  /**
   * Essai de 7 × 24 h, rang 1 de la chaîne, MÊME session que la création de
   * l'organisation (aucune transaction imbriquée) : un rollback de la
   * création n'en laisse aucune trace. Référence déterministe
   * `trial:<organizationId>` ; l'index partiel `kind: trial` interdit un
   * second essai, même avec une autre référence.
   */
  async grantTrial(
    organizationId: Types.ObjectId,
    session: MongooseSession,
  ): Promise<SubscriptionPeriodDocument> {
    const already = await this.periodModel
      .exists({ organizationId })
      .session(session);
    if (already) {
      throw new SubscriptionGrantError(
        'TRIAL_ALREADY_GRANTED',
        "L'essai n'est attribué qu'à la création de l'organisation.",
      );
    }
    const startsAt = this.clock();
    const [period] = await this.periodModel.create(
      [
        {
          organizationId,
          sequence: 1,
          kind: SubscriptionPeriodKind.TRIAL,
          term: null,
          startsAt,
          endsAt: computeTrialEndsAt(startsAt),
          source: SubscriptionSource.TRIAL,
          sourceReference: trialSourceReference(organizationId.toString()),
          grantedBy: TRIAL_GRANTOR,
          previousPeriodId: null,
        },
      ],
      { session },
    );
    return period;
  }

  /**
   * Attribution manuelle (`source: manual`) idempotente sur
   * `{ source, sourceReference }` :
   * - même demande canonique (organisation + durée) → même période ;
   * - autre organisation ou durée → `SUBSCRIPTION_REFERENCE_CONFLICT`,
   *   aucune écriture. `grantedBy` n'entre pas dans la comparaison.
   *
   * `startsAt = max(heure serveur, fin de couverture déjà accordée)`.
   * Concurrence : le rang `sequence` (index unique par organisation)
   * sérialise les attributions en base ; une collision relance la
   * transaction (relecture de la chaîne), au plus `MAX_GRANT_ATTEMPTS` fois.
   */
  async grantSubscription(
    input: GrantSubscriptionInput,
  ): Promise<GrantedPeriodView> {
    const request = this.validate(input);

    for (let attempt = 1; attempt <= MAX_GRANT_ATTEMPTS; attempt++) {
      let applied: SubscriptionPeriodDocument | undefined;
      let replayed = false;
      const session = await this.connection.startSession();
      try {
        await session.withTransaction(async () => {
          const result = await this.applyGrant(request, session);
          applied = result.period;
          replayed = result.replayed;
        });
      } catch (error) {
        const index = subscriptionDuplicateKeyIndex(error);
        // Rejeu concurrent de la même référence (relu au prochain tour) ou
        // rang déjà pris par une autre attribution (chaîne relue). Tout autre
        // E11000 ou erreur est relancé tel quel.
        if (
          index === 'source_1_sourceReference_1' ||
          index === 'organizationId_1_sequence_1'
        ) {
          continue;
        }
        throw error;
      } finally {
        await session.endSession();
      }
      if (!applied) {
        throw new Error('Subscription grant completed without a period');
      }
      if (replayed) this.assertSameRequest(applied, request);
      return this.toGrantedView(applied, replayed);
    }
    throw new SubscriptionGrantError(
      'GRANT_CONTENTION',
      'Attribution impossible : trop de conflits concurrents, réessayer.',
    );
  }

  /** État commercial à l'heure serveur ; organisation issue du contexte. */
  async getState(organizationId: string): Promise<SubscriptionStateView> {
    const periods = await this.periodModel
      .find({ organizationId: new Types.ObjectId(organizationId) })
      .select({ sequence: 1, kind: 1, term: 1, startsAt: 1, endsAt: 1 })
      .lean()
      .exec();
    return computeSubscriptionState(periods, this.clock());
  }

  private async applyGrant(
    request: {
      organizationId: Types.ObjectId;
      term: SubscriptionTerm;
      sourceReference: string;
      grantedBy: string;
    },
    session: MongooseSession,
  ): Promise<{ period: SubscriptionPeriodDocument; replayed: boolean }> {
    const existing = await this.periodModel
      .findOne({
        source: SubscriptionSource.MANUAL,
        sourceReference: request.sourceReference,
      })
      .session(session)
      .exec();
    if (existing) return { period: existing, replayed: true };

    const organization = await this.organizationModel
      .exists({ _id: request.organizationId })
      .session(session);
    if (!organization) {
      throw new SubscriptionGrantError(
        'ORGANIZATION_NOT_FOUND',
        'Organisation introuvable.',
      );
    }

    // Séquentiel : jamais d'opérations parallèles sur une session
    // transactionnelle. `last` = maillon à prolonger ; `latestEnd` = fin de
    // couverture (périodes futures comprises).
    const last = await this.periodModel
      .findOne({ organizationId: request.organizationId })
      .sort({ sequence: -1 })
      .session(session)
      .exec();
    const latestEnd = await this.periodModel
      .findOne({ organizationId: request.organizationId })
      .sort({ endsAt: -1 })
      .select({ endsAt: 1 })
      .session(session)
      .exec();

    const startsAt = computeRenewalStartsAt(
      this.clock(),
      latestEnd?.endsAt ?? null,
    );
    const [period] = await this.periodModel.create(
      [
        {
          organizationId: request.organizationId,
          sequence: (last?.sequence ?? 0) + 1,
          kind: SubscriptionPeriodKind.SUBSCRIPTION,
          term: request.term,
          startsAt,
          endsAt: computeSubscriptionEndsAt(startsAt, request.term),
          source: SubscriptionSource.MANUAL,
          sourceReference: request.sourceReference,
          grantedBy: request.grantedBy,
          previousPeriodId: last?._id ?? null,
        },
      ],
      { session },
    );
    return { period, replayed: false };
  }

  private validate(input: GrantSubscriptionInput) {
    if (!isStrictObjectId(input?.organizationId)) {
      throw new SubscriptionGrantError(
        'INVALID_INPUT',
        'organizationId invalide.',
      );
    }
    if (!isSubscriptionTerm(input.term)) {
      throw new SubscriptionGrantError(
        'INVALID_INPUT',
        'Durée invalide (monthly | quarterly | semiannual | annual).',
      );
    }
    const sourceReference = boundedText(
      input.sourceReference,
      SUBSCRIPTION_REFERENCE_MAX_LENGTH,
    );
    if (!sourceReference) {
      throw new SubscriptionGrantError('INVALID_INPUT', 'Référence invalide.');
    }
    const grantedBy = boundedText(
      input.grantedBy,
      SUBSCRIPTION_GRANTOR_MAX_LENGTH,
    );
    if (!grantedBy) {
      throw new SubscriptionGrantError('INVALID_INPUT', 'Opérateur invalide.');
    }
    return {
      organizationId: new Types.ObjectId(input.organizationId),
      term: input.term,
      sourceReference,
      grantedBy,
    };
  }

  /** Comparaison canonique : organisation + nature + durée, jamais l'heure. */
  private assertSameRequest(
    period: SubscriptionPeriodDocument,
    request: { organizationId: Types.ObjectId; term: SubscriptionTerm },
  ): void {
    const same =
      period.organizationId.equals(request.organizationId) &&
      period.kind === SubscriptionPeriodKind.SUBSCRIPTION &&
      period.term === request.term;
    if (!same) {
      throw new SubscriptionGrantError(
        'SUBSCRIPTION_REFERENCE_CONFLICT',
        'Référence déjà utilisée pour une autre attribution.',
      );
    }
  }

  private toGrantedView(
    period: SubscriptionPeriodDocument,
    replayed: boolean,
  ): GrantedPeriodView {
    return {
      periodId: period._id.toString(),
      organizationId: period.organizationId.toString(),
      sequence: period.sequence,
      term: period.term as SubscriptionTerm,
      startsAt: period.startsAt,
      endsAt: period.endsAt,
      replayed,
    };
  }
}
