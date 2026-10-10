import { BadRequestException } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';

/**
 * 1-20E — Historique des ventes PAGINÉ (`GET /sales/history`).
 *
 * Pagination par CURSEUR (clé `createdAt` décroissante, `_id` décroissant en
 * départage) : coût constant quelle que soit la profondeur, et pages
 * stables quand des ventes sont ajoutées pendant la navigation (elles
 * n'apparaissent qu'en tête, jamais en doublon ni en saut). Le curseur est
 * opaque pour le client (base64url de `[createdAt ISO, _id]`).
 */
export const SALES_HISTORY_DEFAULT_LIMIT = 20;
export const SALES_HISTORY_MAX_LIMIT = 100;

export interface SalesHistoryCursor {
  createdAt: Date;
  id: Types.ObjectId;
}

export function encodeSalesHistoryCursor(sale: {
  createdAt: Date;
  _id: Types.ObjectId | string;
}): string {
  return Buffer.from(
    JSON.stringify([sale.createdAt.toISOString(), String(sale._id)]),
  ).toString('base64url');
}

export const INVALID_SALES_CURSOR = 'INVALID_SALES_CURSOR';

/** Curseur reçu → clé ; 400 `INVALID_SALES_CURSOR` sinon. */
export function decodeSalesHistoryCursor(value: string): SalesHistoryCursor {
  const invalid = () =>
    new BadRequestException({
      code: INVALID_SALES_CURSOR,
      message: 'Invalid sales cursor',
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    !/^[0-9a-f]{24}$/i.test(parsed[1])
  ) {
    throw invalid();
  }
  const createdAt = new Date(parsed[0]);
  if (Number.isNaN(createdAt.getTime())) throw invalid();
  return { createdAt, id: new Types.ObjectId(parsed[1]) };
}

/**
 * Index de l'historique paginé : tri `createdAt` puis `_id` décroissants,
 * sur toute l'organisation (`sales.view_all`) ou les ventes d'un vendeur
 * (`sales.view_own`). L'index existant `{organizationId, productId,
 * createdAt}` ne sert pas ce tri sans produit.
 */
type IndexKey = Readonly<Record<string, 1 | -1>>;

export const SALE_HISTORY_INDEXES: ReadonlyArray<{
  name: string;
  key: IndexKey;
}> = Object.freeze<Array<{ name: string; key: IndexKey }>>([
  {
    name: 'organizationId_1_createdAt_-1__id_-1',
    key: { organizationId: 1, createdAt: -1, _id: -1 },
  },
  {
    name: 'organizationId_1_sellerId_1_createdAt_-1__id_-1',
    key: { organizationId: 1, sellerId: 1, createdAt: -1, _id: -1 },
  },
]);

const SALES_COLLECTION = 'sales';
const NAMESPACE_NOT_FOUND = 26;

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>) {
  const x = Object.entries(a);
  const y = Object.entries(b);
  return (
    x.length === y.length &&
    x.every(([field, dir], i) => y[i][0] === field && y[i][1] === dir)
  );
}

/**
 * Idempotent : crée les index absents (clé exacte), ne touche à rien
 * d'autre ; MongoDB lève si un index homonyme a d'autres options (jamais
 * écrasé). Renvoie les noms créés.
 */
export async function ensureSaleHistoryIndexes(
  connection: Connection,
): Promise<string[]> {
  const db = connection.db;
  if (!db) throw new Error('connexion MongoDB non prête');
  let existing: Array<{ key: Record<string, unknown> }> = [];
  try {
    existing = (await db
      .collection(SALES_COLLECTION)
      .listIndexes()
      .toArray()) as Array<{ key: Record<string, unknown> }>;
  } catch (error) {
    if ((error as { code?: unknown }).code !== NAMESPACE_NOT_FOUND) throw error;
  }
  const created: string[] = [];
  for (const index of SALE_HISTORY_INDEXES) {
    if (existing.some((i) => sameKey(i.key, index.key))) continue;
    await db
      .collection(SALES_COLLECTION)
      .createIndex({ ...index.key }, { name: index.name });
    created.push(index.name);
  }
  return created;
}
