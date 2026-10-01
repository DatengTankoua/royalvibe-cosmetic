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
  GrantableSubscriptionSource,
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
  isGrantableSubscriptionSource,
  isSubscriptionTerm,
  trialSourceReference,
} from './subscription-terms';
import { subscriptionDuplicateKeyIndex } from './subscription-period-indexes';
import type { SubscriptionAccessDecision } from './subscription-access';
import { SUBSCRIPTION_CLOCK } from './subscription-clock';
import type { SubscriptionClock } from './subscription-clock';

export type MongooseSession = Awaited<ReturnType<Connection['startSession']>>;

/** Reprises bornées après collision de chaînage (attributions concurrentes). */
export const MAX_GRANT_ATTEMPTS = 5;

/**
 * Index dont une collision E11000 justifie de REJOUER la transaction
 * complète : rejeu concurrent d'une même référence (relu au tour suivant)
 * ou rang déjà pris par une autre attribution (chaîne relue). Toute autre
 * collision (essai unique, index d'un appelant) est relancée telle quelle.
 */
const RETRYABLE_GRANT_INDEXES: ReadonlySet<string> = new Set([
  'source_1_sourceReference_1',
  'organizationId_1_sequence_1',
]);

export function isRetryableGrantCollision(error: unknown): boolean {
  const index = subscriptionDuplicateKeyIndex(error);
  return index !== null && RETRYABLE_GRANT_INDEXES.has(index);
}

export type SubscriptionGrantErrorCode =
  | 'INVALID_INPUT'
  | 'ORGANIZATION_NOT_FOUND'
  | 'SUBSCRIPTION_REFERENCE_CONFLICT'
  | 'TRIAL_ALREADY_GRANTED'
  | 'GRANT_CONTENTION'
  | 'TRANSACTION_REQUIRED';

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

/**
 * 1-14D.2A — attribution dans la transaction de l'APPELANT (code serveur
 * uniquement, jamais une entrée HTTP) : la source est explicite.
 */
export interface GrantSubscriptionInSessionInput extends GrantSubscriptionInput {
  source: GrantableSubscriptionSource;
}

interface ValidatedGrantRequest {
  organizationId: Types.ObjectId;
  term: SubscriptionTerm;
  source: GrantableSubscriptionSource;
  sourceReference: string;
  grantedBy: string;
}

/** 1-14C.2 — entrée d'historique exposable (aucun champ interne). */
export interface SubscriptionPeriodHistoryEntry {
  kind: SubscriptionPeriodKind;
  term: SubscriptionTerm | null;
  startsAt: Date;
  endsAt: Date;
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
   * Attribution manuelle (`source: manual`, CLI et code serveur) idempotente
   * sur `{ source, sourceReference }` :
   * - même demande canonique (organisation + durée) → même période ;
   * - autre organisation ou durée → `SUBSCRIPTION_REFERENCE_CONFLICT`,
   *   aucune écriture. `grantedBy` n'entre pas dans la comparaison.
   *
   * `startsAt = max(heure serveur, fin de couverture déjà accordée)`.
   * La source est TOUJOURS `manual` : aucun champ de l'entrée ne peut la
   * changer (les champs sont recopiés explicitement).
   */
  async grantSubscription(
    input: GrantSubscriptionInput,
  ): Promise<GrantedPeriodView> {
    const { organizationId, term, sourceReference, grantedBy } =
      input ?? ({} as GrantSubscriptionInput);
    const request: GrantSubscriptionInSessionInput = {
      organizationId,
      term,
      sourceReference,
      grantedBy,
      source: SubscriptionSource.MANUAL,
    };
    // Entrée invalide → refus AVANT toute session.
    this.validate(request);
    return this.runInGrantTransaction((session) =>
      this.grantSubscriptionInSession(request, session),
    );
  }

  /**
   * 1-14D.2A — exécute `work` dans UNE transaction complète, rejouée en
   * entier (nouvelle session, nouvelle transaction) après une collision des
   * index d'idempotence ou de séquence, au plus `MAX_GRANT_ATTEMPTS` fois ;
   * puis `GRANT_CONTENTION`. Toute autre erreur est relancée telle quelle,
   * transaction annulée.
   *
   * Contrat de `work` :
   * - toutes ses lectures/écritures utilisent la session reçue ;
   * - il ne capture JAMAIS une erreur de base pour continuer à écrire :
   *   une erreur d'écriture avorte la transaction ; elle doit remonter ;
   * - aucun appel réseau ni effet externe : le callback peut être rejoué
   *   (reprise ici, ou erreur transitoire gérée par `withTransaction`).
   */
  async runInGrantTransaction<T>(
    work: (session: MongooseSession) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= MAX_GRANT_ATTEMPTS; attempt++) {
      let outcome: { value: T } | undefined;
      const session = await this.connection.startSession();
      try {
        await session.withTransaction(async () => {
          // Rejoué par `withTransaction` (erreur transitoire) : seul le
          // résultat de la dernière exécution validée est conservé.
          outcome = undefined;
          outcome = { value: await work(session) };
        });
      } catch (error) {
        if (isRetryableGrantCollision(error)) continue;
        throw error;
      } finally {
        await session.endSession();
      }
      if (!outcome) {
        throw new Error(
          'Subscription grant transaction completed without result',
        );
      }
      return outcome.value;
    }
    throw new SubscriptionGrantError(
      'GRANT_CONTENTION',
      'Attribution impossible : trop de conflits concurrents, réessayer.',
    );
  }

  /**
   * 1-14D.2A — attribution d'un abonnement dans la transaction ACTIVE de
   * l'appelant (ex. : marquage d'un paiement et sa période, ensemble). N'ouvre,
   * ne valide ni n'annule aucune transaction ; toutes les lectures/écritures
   * passent par `session`.
   *
   * - Idempotence sur EXACTEMENT `{ source, sourceReference }` : une même
   *   référence sous `manual` et `payment` désigne deux attributions
   *   distinctes.
   * - Rejeu de la même demande (organisation + durée) → période existante,
   *   `replayed: true`, aucune écriture ; demande différente →
   *   `SUBSCRIPTION_REFERENCE_CONFLICT` (l'appelant laisse l'erreur avorter
   *   la transaction).
   * - Une collision d'index concurrente remonte (E11000) : la transaction
   *   est avortée côté serveur, l'appelant la rejoue en entier
   *   (`runInGrantTransaction`).
   */
  async grantSubscriptionInSession(
    input: GrantSubscriptionInSessionInput,
    session: MongooseSession,
  ): Promise<GrantedPeriodView> {
    if (
      typeof session?.inTransaction !== 'function' ||
      !session.inTransaction()
    ) {
      throw new SubscriptionGrantError(
        'TRANSACTION_REQUIRED',
        'Une transaction active de l’appelant est requise.',
      );
    }
    const request = this.validate(input);
    const { period, replayed } = await this.applyGrant(request, session);
    if (replayed) this.assertSameRequest(period, request);
    return this.toGrantedView(period, replayed);
  }

  /** État commercial à l'heure serveur ; organisation issue du contexte. */
  async getState(organizationId: string): Promise<SubscriptionStateView> {
    return (await this.getStateWithHistory(organizationId)).view;
  }

  /**
   * 1-14C.2 — état ET historique des périodes, en UNE lecture. L'historique
   * est une projection explicite (nature, durée, début, fin), de la plus
   * récente à la plus ancienne : jamais de référence, d'opérateur, de
   * source ni de rang de chaîne. Lecture seule.
   */
  async getStateWithHistory(organizationId: string): Promise<{
    view: SubscriptionStateView;
    periods: SubscriptionPeriodHistoryEntry[];
  }> {
    const periods = await this.periodModel
      .find({ organizationId: new Types.ObjectId(organizationId) })
      .select({ sequence: 1, kind: 1, term: 1, startsAt: 1, endsAt: 1 })
      .lean()
      .exec();
    return {
      view: computeSubscriptionState(periods, this.clock()),
      periods: [...periods]
        .sort(
          (a, b) =>
            b.startsAt.getTime() - a.startsAt.getTime() ||
            b.sequence - a.sequence,
        )
        .map((p) => ({
          kind: p.kind,
          term: p.term,
          startsAt: p.startsAt,
          endsAt: p.endsAt,
        })),
    };
  }

  /**
   * 1-14C.1 — décision d'accès commercial à l'heure serveur. Seul `active`
   * ouvre l'accès applicatif (`none`, `expired`, `scheduled` le ferment).
   * Une erreur de lecture est propagée : l'appelant refuse l'accès sans la
   * présenter comme une expiration.
   */
  async getAccessDecision(
    organizationId: string,
  ): Promise<SubscriptionAccessDecision> {
    const checkedAt = this.clock();
    const periods = await this.periodModel
      .find({ organizationId: new Types.ObjectId(organizationId) })
      .select({ sequence: 1, kind: 1, term: 1, startsAt: 1, endsAt: 1 })
      .lean()
      .exec();
    const view = computeSubscriptionState(periods, checkedAt);
    return {
      state: view.state,
      active: view.state === 'active',
      coverageEndsAt: view.coverageEndsAt,
      checkedAt,
    };
  }

  /** Heure serveur de référence (horloge injectée). */
  now(): Date {
    return this.clock();
  }

  private async applyGrant(
    request: ValidatedGrantRequest,
    session: MongooseSession,
  ): Promise<{ period: SubscriptionPeriodDocument; replayed: boolean }> {
    // Idempotence sur EXACTEMENT `{ source, sourceReference }` (index 1).
    const existing = await this.periodModel
      .findOne({
        source: request.source,
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
          source: request.source,
          sourceReference: request.sourceReference,
          grantedBy: request.grantedBy,
          previousPeriodId: last?._id ?? null,
        },
      ],
      { session },
    );
    return { period, replayed: false };
  }

  private validate(
    input: GrantSubscriptionInSessionInput,
  ): ValidatedGrantRequest {
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
    // Jamais `trial` : l'essai n'est attribué qu'à la création.
    if (!isGrantableSubscriptionSource(input.source)) {
      throw new SubscriptionGrantError('INVALID_INPUT', 'Source invalide.');
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
      source: input.source,
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
