import { BadRequestException } from '@nestjs/common';
import {
  SALE_OCCURRED_AT_MAX_FUTURE_MS,
  SALE_OCCURRED_AT_MAX_PAST_MS,
  computeSaleRequestHash,
  isSaleOperationDuplicateKeyError,
  normalizeCreateSale,
  resolveOccurredAt,
} from './sale-idempotency';
import { SALE_ERROR_CODES } from './sale-error-codes';

const PRODUCT = '112233445566778899001122';

describe('sale-idempotency (1-11C.1)', () => {
  describe('normalizeCreateSale + computeSaleRequestHash', () => {
    const base = { productId: PRODUCT, quantity: 2, salePrice: 500 };

    it('hash SHA-256 hex déterministe', () => {
      const h = computeSaleRequestHash(normalizeCreateSale(base));
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(computeSaleRequestHash(normalizeCreateSale({ ...base }))).toBe(h);
    });

    it('indépendant de l’ordre des clés, de la casse du productId, des espaces acheteur et du format ms', () => {
      const a = normalizeCreateSale({
        ...base,
        buyerName: 'Bob',
        occurredAt: '2026-09-20T10:00:00Z',
      });
      const b = normalizeCreateSale({
        occurredAt: '2026-09-20T10:00:00.000Z',
        buyerName: '  Bob ',
        salePrice: 500,
        quantity: 2,
        productId: PRODUCT.toUpperCase(),
      });
      expect(b).toEqual(a);
      expect(computeSaleRequestHash(b)).toBe(computeSaleRequestHash(a));
    });

    it('champs optionnels absents → null ; chaque champ modifie le hash', () => {
      const n = normalizeCreateSale(base);
      expect(n).toEqual({
        productId: PRODUCT,
        quantity: 2,
        salePrice: 500,
        buyerName: null,
        buyerContact: null,
        occurredAt: null,
      });
      const h = computeSaleRequestHash(n);
      const variants = [
        { ...n, productId: 'aa2233445566778899001122' },
        { ...n, quantity: 3 },
        { ...n, salePrice: 501 },
        { ...n, buyerName: 'Bob' },
        { ...n, buyerName: '' },
        { ...n, buyerContact: 'x' },
        { ...n, occurredAt: '2026-09-20T10:00:00.000Z' },
      ];
      for (const v of variants) expect(computeSaleRequestHash(v)).not.toBe(h);
    });
  });

  describe('resolveOccurredAt', () => {
    const now = new Date('2026-09-28T12:00:00.000Z');
    const at = (deltaMs: number) =>
      new Date(now.getTime() + deltaMs).toISOString();
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
        return undefined;
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        return ((e as BadRequestException).getResponse() as { code?: string })
          .code;
      }
    };

    it('absent → heure serveur', () => {
      expect(resolveOccurredAt(null, now)).toBe(now);
    });

    it('bornes incluses : -14 j et +5 min acceptés', () => {
      expect(
        resolveOccurredAt(at(-SALE_OCCURRED_AT_MAX_PAST_MS), now).getTime(),
      ).toBe(now.getTime() - SALE_OCCURRED_AT_MAX_PAST_MS);
      expect(
        resolveOccurredAt(at(SALE_OCCURRED_AT_MAX_FUTURE_MS), now).getTime(),
      ).toBe(now.getTime() + SALE_OCCURRED_AT_MAX_FUTURE_MS);
    });

    it('hors plage ou invalide → 400 SALE_DATE_OUT_OF_RANGE', () => {
      for (const value of [
        at(-SALE_OCCURRED_AT_MAX_PAST_MS - 1),
        at(SALE_OCCURRED_AT_MAX_FUTURE_MS + 1),
        'not-a-date',
      ]) {
        expect(codeOf(() => resolveOccurredAt(value, now))).toBe(
          SALE_ERROR_CODES.SALE_DATE_OUT_OF_RANGE,
        );
      }
    });
  });

  describe('isSaleOperationDuplicateKeyError', () => {
    const e11000 = (keyPattern: unknown) => ({ code: 11000, keyPattern });

    it('vrai uniquement pour la clé exacte {organizationId, clientOperationId}', () => {
      expect(
        isSaleOperationDuplicateKeyError(
          e11000({ organizationId: 1, clientOperationId: 1 }),
        ),
      ).toBe(true);
      expect(isSaleOperationDuplicateKeyError(e11000({ email: 1 }))).toBe(
        false,
      );
      expect(
        isSaleOperationDuplicateKeyError(e11000({ clientOperationId: 1 })),
      ).toBe(false);
      expect(
        isSaleOperationDuplicateKeyError(
          e11000({ clientOperationId: 1, organizationId: 1 }),
        ),
      ).toBe(false);
      expect(
        isSaleOperationDuplicateKeyError({
          code: 11001,
          keyPattern: { organizationId: 1, clientOperationId: 1 },
        }),
      ).toBe(false);
      expect(isSaleOperationDuplicateKeyError(e11000(undefined))).toBe(false);
      expect(isSaleOperationDuplicateKeyError(null)).toBe(false);
      expect(isSaleOperationDuplicateKeyError(new Error('x'))).toBe(false);
    });
  });
});
