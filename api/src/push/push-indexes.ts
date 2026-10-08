import type { Connection } from 'mongoose';
import {
  describeOne,
  IndexDescription,
  RequiredPaymentIndex,
} from '../subscriptions/payments/subscription-payment-indexes';
import { PUSH_SUBSCRIPTIONS_COLLECTION } from './schemas/push-subscription.schema';
import { PUSH_JOBS_COLLECTION } from './schemas/push-job.schema';
import { PUSH_DELIVERIES_COLLECTION } from './schemas/push-delivery.schema';
import { NOTIFICATIONS_COLLECTION } from '../notifications/schemas/notification.schema';
import { NOTIFICATION_PREFERENCES_COLLECTION } from '../notifications/schemas/notification-preference.schema';
import { MONTHLY_REPORTS_COLLECTION } from '../notifications/schemas/monthly-report.schema';

/** Index requis ; `expireAfterSeconds` : index TTL attendu EXACTEMENT. */
export interface RequiredNotificationIndex extends RequiredPaymentIndex {
  expireAfterSeconds?: number;
}

/**
 * 1-16A / 1-16A.1 — Index REQUIS des notifications (même contrat que
 * `subscription-payment-indexes.ts`) : création EXPLICITE et idempotente
 * (migration `migrate:push-notification-indexes`, tests éphémères), jamais au
 * démarrage ; vérification EXACTE au démarrage HTTP en production (et dès
 * que `WEB_PUSH_ENABLED=true`) ; une configuration incompatible n'est jamais
 * écrasée.
 *
 * - `push_subscriptions` : endpoint unique (un appareil = un titulaire),
 *   lecture des appareils d'un membre et d'une organisation ;
 * - `push_jobs` : un travail par événement (`eventKey`), file des travaux,
 *   dernier franchissement d'un produit ;
 * - `push_deliveries` : une livraison par événement et appareil, file des
 *   envois ;
 * - `notifications` (1-16A.1) : une notification par événement et
 *   utilisateur, liste paginée, compteur des non lues, et le SEUL index TTL
 *   (`expiresAt`, 0 s : suppression après la date calculée à la lecture ;
 *   `null` tant que non lue, donc jamais supprimée) ;
 * - `notification_preferences` : un document par utilisateur et organisation ;
 * - `monthly_reports` : un bilan par organisation et mois.
 * Aucun autre TTL.
 */
export const PUSH_INDEXES: Readonly<
  Record<string, readonly RequiredNotificationIndex[]>
> = Object.freeze({
  [PUSH_SUBSCRIPTIONS_COLLECTION]: Object.freeze([
    Object.freeze({
      name: 'endpointHash_1',
      key: Object.freeze({ endpointHash: 1 } as const),
      unique: true,
    }),
    Object.freeze({
      name: 'userId_1_organizationId_1_status_1',
      key: Object.freeze({ userId: 1, organizationId: 1, status: 1 } as const),
      unique: false,
    }),
    Object.freeze({
      name: 'organizationId_1_status_1',
      key: Object.freeze({ organizationId: 1, status: 1 } as const),
      unique: false,
    }),
  ]),
  [PUSH_JOBS_COLLECTION]: Object.freeze([
    Object.freeze({
      name: 'eventKey_1',
      key: Object.freeze({ eventKey: 1 } as const),
      unique: true,
    }),
    Object.freeze({
      name: 'status_1_eventAt_1',
      key: Object.freeze({ status: 1, eventAt: 1 } as const),
      unique: false,
    }),
    Object.freeze({
      name: 'productId_1_eventAt_-1',
      key: Object.freeze({ productId: 1, eventAt: -1 } as const),
      unique: false,
    }),
  ]),
  [PUSH_DELIVERIES_COLLECTION]: Object.freeze([
    Object.freeze({
      name: 'jobId_1_subscriptionId_1',
      key: Object.freeze({ jobId: 1, subscriptionId: 1 } as const),
      unique: true,
    }),
    Object.freeze({
      name: 'status_1_nextAttemptAt_1',
      key: Object.freeze({ status: 1, nextAttemptAt: 1 } as const),
      unique: false,
    }),
  ]),
  [NOTIFICATIONS_COLLECTION]: Object.freeze([
    Object.freeze({
      name: 'eventKey_1_userId_1',
      key: Object.freeze({ eventKey: 1, userId: 1 } as const),
      unique: true,
    }),
    Object.freeze({
      name: 'userId_1_organizationId_1__id_-1',
      key: Object.freeze({ userId: 1, organizationId: 1, _id: -1 } as const),
      unique: false,
    }),
    Object.freeze({
      name: 'userId_1_organizationId_1_readAt_1',
      key: Object.freeze({ userId: 1, organizationId: 1, readAt: 1 } as const),
      unique: false,
    }),
    Object.freeze({
      name: 'expiresAt_1_ttl',
      key: Object.freeze({ expiresAt: 1 } as const),
      unique: false,
      expireAfterSeconds: 0,
    }),
  ]),
  [NOTIFICATION_PREFERENCES_COLLECTION]: Object.freeze([
    Object.freeze({
      name: 'userId_1_organizationId_1',
      key: Object.freeze({ userId: 1, organizationId: 1 } as const),
      unique: true,
    }),
  ]),
  [MONTHLY_REPORTS_COLLECTION]: Object.freeze([
    Object.freeze({
      name: 'organizationId_1_period_1',
      key: Object.freeze({ organizationId: 1, period: 1 } as const),
      unique: true,
    }),
  ]),
});

const NAMESPACE_NOT_FOUND = 26;

export class PushIndexError extends Error {
  constructor(collection: string, reason: string) {
    super(
      `Index ${collection} invalides : ${reason}. ` +
        'Exécuter la migration `pnpm --filter api migrate:push-notification-indexes`.',
    );
    this.name = 'PushIndexError';
  }
}

function database(connection: Connection) {
  const db = connection.db;
  if (!db) throw new PushIndexError('push', 'connexion MongoDB non prête');
  return db;
}

async function listIndexes(
  connection: Connection,
  collection: string,
): Promise<IndexDescription[]> {
  try {
    return (await database(connection)
      .collection(collection)
      .listIndexes()
      .toArray()) as IndexDescription[];
  } catch (error) {
    if ((error as { code?: unknown }).code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}

/** Problème d'UN index requis (TTL exact, ou contrat sans TTL). */
function describeRequired(
  indexes: readonly IndexDescription[],
  required: RequiredNotificationIndex,
): string | null {
  if (required.expireAfterSeconds === undefined) {
    return describeOne(indexes, required);
  }
  const keyOf = (i: IndexDescription) => JSON.stringify(i.key);
  const index = indexes.find((i) => keyOf(i) === JSON.stringify(required.key));
  if (!index) return `${required.name} : index absent`;
  if (index.unique === true) return `${required.name} : unicité inattendue`;
  if (Number(index.expireAfterSeconds) !== required.expireAfterSeconds) {
    return `${required.name} : TTL inattendu`;
  }
  if (index.partialFilterExpression !== undefined || index.sparse === true) {
    return `${required.name} : options inattendues`;
  }
  return null;
}

/** Premier problème d'une collection, ou `null` si conforme. */
export function describePushIndexProblem(
  collection: string,
  indexes: readonly IndexDescription[],
): string | null {
  const required = PUSH_INDEXES[collection] ?? [];
  for (const index of required) {
    const problem = describeRequired(indexes, index);
    if (problem) return problem;
  }
  // Aucun TTL hors des index TTL requis.
  const allowedTtl = new Set(
    required
      .filter((r) => r.expireAfterSeconds !== undefined)
      .map((r) => JSON.stringify(r.key)),
  );
  const ttl = indexes.find(
    (i) =>
      i.expireAfterSeconds !== undefined &&
      !allowedTtl.has(JSON.stringify(i.key)),
  );
  return ttl ? `${ttl.name ?? 'index'} : TTL interdit` : null;
}

export async function verifyPushIndexes(connection: Connection): Promise<void> {
  for (const collection of Object.keys(PUSH_INDEXES)) {
    const problem = describePushIndexProblem(
      collection,
      await listIndexes(connection, collection),
    );
    if (problem) throw new PushIndexError(collection, problem);
  }
}

/**
 * Idempotent : no-op si tous les index exacts existent. Sinon, validation
 * COMPLÈTE de toutes les collections avant toute création (aucune création
 * partielle sur configuration incompatible), puis création des absents et
 * revérification.
 */
export async function ensurePushIndexes(
  connection: Connection,
): Promise<'already-present' | 'created'> {
  const missing: Array<{
    collection: string;
    index: RequiredNotificationIndex;
  }> = [];
  for (const collection of Object.keys(PUSH_INDEXES)) {
    const existing = await listIndexes(connection, collection);
    for (const required of PUSH_INDEXES[collection]) {
      const problem = describeRequired(existing, required);
      if (!problem) continue;
      if (!problem.endsWith('index absent')) {
        throw new PushIndexError(collection, problem);
      }
      missing.push({ collection, index: required });
    }
    const problem = describePushIndexProblem(
      collection,
      existing.filter(
        (i) =>
          !missing.some(
            (m) =>
              m.collection === collection &&
              JSON.stringify(m.index.key) === JSON.stringify(i.key),
          ),
      ),
    );
    if (problem && problem.endsWith('TTL interdit')) {
      throw new PushIndexError(collection, problem);
    }
  }
  if (missing.length === 0) return 'already-present';
  for (const { collection, index } of missing) {
    await database(connection)
      .collection(collection)
      .createIndex(
        { ...index.key },
        {
          name: index.name,
          ...(index.unique ? { unique: true } : {}),
          ...(index.expireAfterSeconds !== undefined
            ? { expireAfterSeconds: index.expireAfterSeconds }
            : {}),
        },
      );
  }
  await verifyPushIndexes(connection);
  return 'created';
}
