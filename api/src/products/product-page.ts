import { BadRequestException } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';

/**
 * 1-20F — Liste PAGINÉE des produits (`GET /products?limit=…`).
 *
 * Contrat explicite : la présence de `limit` sélectionne la réponse paginée
 * `{ items, total, scopeTotal, nextCursor }` ; sans `limit`, `GET /products`
 * renvoie toujours le tableau complet (anciens clients, `ids` de 1-20D).
 *
 * Pagination par CURSEUR sur le seul tri existant (`createdAt` décroissant),
 * `_id` décroissant en départage : coût indépendant de la profondeur, et
 * pages stables (un produit créé n'apparaît qu'en tête). `createdAt` n'est
 * jamais modifié (horodatage Mongoose depuis le premier schéma) : ni une
 * modification, ni un déplacement, ni une restauration ne déplacent un
 * produit dans le tri. Curseur opaque : base64url de `[createdAt ISO, _id]`.
 */
export const PRODUCT_PAGE_DEFAULT_LIMIT = 24;
export const PRODUCT_PAGE_MAX_LIMIT = 100;
/** Au-delà de la limite de longueur d'un nom (200) : rien ne peut correspondre. */
export const PRODUCT_SEARCH_MAX_LENGTH = 200;
const CURSOR_MAX_LENGTH = 200;

export const INVALID_PRODUCT_PAGE = 'INVALID_PRODUCT_PAGE';

function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: INVALID_PRODUCT_PAGE, message });
}

export interface ProductPageCursor {
  createdAt: Date;
  id: Types.ObjectId;
}

export interface ProductPageQuery {
  limit: number;
  cursor?: ProductPageCursor;
  /** Texte recherché tel que saisi (jamais une expression régulière). */
  search?: string;
}

export function encodeProductPageCursor(product: {
  createdAt?: Date | null;
  _id: Types.ObjectId | string;
}): string {
  if (!(product.createdAt instanceof Date)) {
    // Invariant du schéma (horodatage) : jamais un curseur incomplet.
    throw new Error('produit sans createdAt : curseur impossible');
  }
  return Buffer.from(
    JSON.stringify([product.createdAt.toISOString(), String(product._id)]),
  ).toString('base64url');
}

export function decodeProductPageCursor(value: string): ProductPageCursor {
  if (value.length === 0 || value.length > CURSOR_MAX_LENGTH) {
    throw invalid('Invalid products cursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalid('Invalid products cursor');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    !/^[0-9a-f]{24}$/i.test(parsed[1])
  ) {
    throw invalid('Invalid products cursor');
  }
  const createdAt = new Date(parsed[0]);
  if (Number.isNaN(createdAt.getTime())) {
    throw invalid('Invalid products cursor');
  }
  return { createdAt, id: new Types.ObjectId(parsed[1]) };
}

/**
 * Paramètres bruts de la requête → requête validée ; `undefined` si `limit`
 * est absent (ancien contrat). 400 `INVALID_PRODUCT_PAGE` sinon.
 */
export function parseProductPageQuery(raw: {
  limit?: unknown;
  cursor?: unknown;
  q?: unknown;
}): ProductPageQuery | undefined {
  if (raw.limit === undefined) {
    if (raw.cursor !== undefined || raw.q !== undefined) {
      throw invalid('cursor and q require limit');
    }
    return undefined;
  }
  if (typeof raw.limit !== 'string' || !/^[0-9]{1,3}$/.test(raw.limit)) {
    throw invalid(
      `limit must be an integer from 1 to ${PRODUCT_PAGE_MAX_LIMIT}`,
    );
  }
  const limit = Number(raw.limit);
  if (limit < 1 || limit > PRODUCT_PAGE_MAX_LIMIT) {
    throw invalid(
      `limit must be an integer from 1 to ${PRODUCT_PAGE_MAX_LIMIT}`,
    );
  }
  const query: ProductPageQuery = { limit };
  if (raw.cursor !== undefined) {
    if (typeof raw.cursor !== 'string')
      throw invalid('Invalid products cursor');
    query.cursor = decodeProductPageCursor(raw.cursor);
  }
  if (raw.q !== undefined) {
    if (
      typeof raw.q !== 'string' ||
      raw.q.trim().length === 0 ||
      raw.q.length > PRODUCT_SEARCH_MAX_LENGTH
    ) {
      throw invalid(
        `q must contain 1 to ${PRODUCT_SEARCH_MAX_LENGTH} characters`,
      );
    }
    query.search = raw.q;
  }
  return query;
}

/**
 * Règle de recherche INCHANGÉE (celle de la page d'un rayon avant 1-20F) :
 * le nom contient le texte saisi, sans distinction de casse, accents
 * distingués. Le texte est échappé : aucun motif fourni par le client.
 */
export function productNameSearch(search: string): RegExp {
  return new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

/**
 * Filtre de la page : `createdAt ≤ curseur` borne le parcours d'index (coût
 * indépendant de la profondeur) ; `$or` départage exactement par `_id` à
 * date égale. Même forme que l'historique des ventes (1-20E).
 */
export function productPageFilter(
  base: Record<string, unknown>,
  cursor: ProductPageCursor | undefined,
): Record<string, unknown> {
  if (!cursor) return base;
  return {
    ...base,
    createdAt: { $lte: cursor.createdAt },
    $or: [
      { createdAt: { $lt: cursor.createdAt } },
      { _id: { $lt: cursor.id } },
    ],
  };
}

export const PRODUCT_PAGE_SORT = Object.freeze({
  createdAt: -1,
  _id: -1,
} as const);

/**
 * Index de la page d'un rayon : égalités (organisation, rayon, produits
 * actifs) puis le tri. L'index existant `{organizationId, sectionId,
 * deletedAt}` oblige à lire et trier en mémoire TOUT le rayon pour une page.
 */
type IndexKey = Readonly<Record<string, 1 | -1>>;

export const PRODUCT_PAGE_INDEXES: ReadonlyArray<{
  name: string;
  key: IndexKey;
}> = Object.freeze<Array<{ name: string; key: IndexKey }>>([
  {
    name: 'organizationId_1_sectionId_1_deletedAt_1_createdAt_-1__id_-1',
    key: {
      organizationId: 1,
      sectionId: 1,
      deletedAt: 1,
      createdAt: -1,
      _id: -1,
    },
  },
]);

const PRODUCTS_COLLECTION = 'products';
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
export async function ensureProductPageIndexes(
  connection: Connection,
): Promise<string[]> {
  const db = connection.db;
  if (!db) throw new Error('connexion MongoDB non prête');
  let existing: Array<{ key: Record<string, unknown> }> = [];
  try {
    existing = (await db
      .collection(PRODUCTS_COLLECTION)
      .listIndexes()
      .toArray()) as Array<{ key: Record<string, unknown> }>;
  } catch (error) {
    if ((error as { code?: unknown }).code !== NAMESPACE_NOT_FOUND) throw error;
  }
  const created: string[] = [];
  for (const index of PRODUCT_PAGE_INDEXES) {
    if (existing.some((i) => sameKey(i.key, index.key))) continue;
    await db
      .collection(PRODUCTS_COLLECTION)
      .createIndex({ ...index.key }, { name: index.name });
    created.push(index.name);
  }
  return created;
}

/**
 * Contrôle en lecture seule de l'invariant du curseur : nombre de produits
 * sans `createdAt` (attendu : 0). Jamais de donnée métier journalisée.
 */
export async function countProductsWithoutCreatedAt(
  connection: Connection,
): Promise<number> {
  const db = connection.db;
  if (!db) throw new Error('connexion MongoDB non prête');
  return db
    .collection(PRODUCTS_COLLECTION)
    .countDocuments({ createdAt: { $not: { $type: 'date' } } });
}
