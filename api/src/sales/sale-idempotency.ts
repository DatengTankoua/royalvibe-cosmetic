import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { CreateSaleDto } from './dto/create-sale.dto';
import { SALE_ERROR_CODES } from './sale-error-codes';
import { SALE_OPERATION_INDEX_KEY } from './schemas/sale-operation.schema';

/** 1-11C.1 — fenêtre acceptée pour `occurredAt` (heure réelle de la vente). */
export const SALE_OCCURRED_AT_MAX_PAST_MS = 14 * 24 * 60 * 60 * 1000;
export const SALE_OCCURRED_AT_MAX_FUTURE_MS = 5 * 60 * 1000;

/**
 * Champs du DTO normalisés EXPLICITEMENT — mêmes valeurs pour le hash
 * idempotent et pour l'écriture de la vente :
 * - `productId` en hex minuscule (`@IsMongoId` accepte la casse mixte) ;
 * - `buyerName`/`buyerContact` trimés (le schéma `Sale` trime déjà) ;
 *   absents → `null` ;
 * - `occurredAt` ré-sérialisé en ISO UTC milliseconde (`…:00Z` et
 *   `…:00.000Z` sont le même instant) ; absent → `null` (l'heure serveur
 *   n'entre JAMAIS dans le hash, sinon deux rejeux différeraient).
 */
export interface NormalizedSaleInput {
  productId: string;
  quantity: number;
  salePrice: number;
  buyerName: string | null;
  buyerContact: string | null;
  occurredAt: string | null;
}

export function normalizeCreateSale(dto: CreateSaleDto): NormalizedSaleInput {
  return {
    productId: dto.productId.toLowerCase(),
    quantity: dto.quantity,
    salePrice: dto.salePrice,
    buyerName: dto.buyerName === undefined ? null : dto.buyerName.trim(),
    buyerContact:
      dto.buyerContact === undefined ? null : dto.buyerContact.trim(),
    occurredAt:
      dto.occurredAt === undefined ? null : canonicalInstant(dto.occurredAt),
  };
}

// Défensif : une date invalide (déjà refusée par le DTO) reste telle quelle
// pour être rejetée en 400 par `resolveOccurredAt`, jamais un RangeError 500.
function canonicalInstant(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

/**
 * Hash canonique déterministe (SHA-256 hex) : tableau à ORDRE FIXE, donc
 * indépendant de l'ordre des clés du corps reçu. Calculé côté serveur
 * uniquement, jamais journalisé ni renvoyé.
 */
export function computeSaleRequestHash(input: NormalizedSaleInput): string {
  const canonical = JSON.stringify([
    input.productId,
    input.quantity,
    input.salePrice,
    input.buyerName,
    input.buyerContact,
    input.occurredAt,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * `occurredAt` effectif : absent → heure serveur ; fourni → au plus 14 jours
 * dans le passé et 5 minutes dans le futur (sinon 400
 * `SALE_DATE_OUT_OF_RANGE`).
 */
export function resolveOccurredAt(
  occurredAt: string | null,
  now: Date = new Date(),
): Date {
  if (occurredAt === null) return now;
  const value = new Date(occurredAt);
  const delta = value.getTime() - now.getTime();
  if (
    Number.isNaN(value.getTime()) ||
    delta < -SALE_OCCURRED_AT_MAX_PAST_MS ||
    delta > SALE_OCCURRED_AT_MAX_FUTURE_MS
  ) {
    throw new BadRequestException({
      code: SALE_ERROR_CODES.SALE_DATE_OUT_OF_RANGE,
      message: 'La date de vente est hors de la plage autorisée.',
    });
  }
  return value;
}

/**
 * E11000 levé par l'index idempotent `{organizationId, clientOperationId}`
 * UNIQUEMENT. Tout autre E11000 (autre collection/index) doit être relancé.
 */
export function isSaleOperationDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, keyPattern } = error as {
    code?: unknown;
    keyPattern?: unknown;
  };
  if (code !== 11000) return false;
  if (typeof keyPattern !== 'object' || keyPattern === null) return false;
  const actual = Object.keys(keyPattern);
  const expected = Object.keys(SALE_OPERATION_INDEX_KEY);
  return (
    actual.length === expected.length &&
    expected.every((key, i) => actual[i] === key)
  );
}
