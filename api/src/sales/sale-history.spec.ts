import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import {
  SALE_HISTORY_INDEXES,
  decodeSalesHistoryCursor,
  encodeSalesHistoryCursor,
} from './sale-history';

describe('Curseur de l’historique des ventes (1-20E)', () => {
  it('aller-retour exact (date à la milliseconde, identifiant)', () => {
    const sale = {
      createdAt: new Date('2026-09-01T10:00:00.123Z'),
      _id: new Types.ObjectId(),
    };
    const cursor = encodeSalesHistoryCursor(sale);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = decodeSalesHistoryCursor(cursor);
    expect(back.createdAt.getTime()).toBe(sale.createdAt.getTime());
    expect(back.id.equals(sale._id)).toBe(true);
  });

  it.each([
    ['base64 illisible', '%%%'],
    ['pas un tableau', Buffer.from('{"a":1}').toString('base64url')],
    [
      'identifiant invalide',
      Buffer.from('["2026-01-01T00:00:00Z","zz"]').toString('base64url'),
    ],
    [
      'date invalide',
      Buffer.from(`["nope","${'a'.repeat(24)}"]`).toString('base64url'),
    ],
    [
      'longueur inattendue',
      Buffer.from('["2026-01-01T00:00:00Z"]').toString('base64url'),
    ],
  ])('%s → 400 INVALID_SALES_CURSOR', (_label, value) => {
    try {
      decodeSalesHistoryCursor(value);
      throw new Error('aucune erreur');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'INVALID_SALES_CURSOR',
      });
    }
  });

  it('index : tri createdAt puis _id décroissants, tenant en tête', () => {
    expect(SALE_HISTORY_INDEXES.map((i) => Object.entries(i.key))).toEqual([
      [
        ['organizationId', 1],
        ['createdAt', -1],
        ['_id', -1],
      ],
      [
        ['organizationId', 1],
        ['sellerId', 1],
        ['createdAt', -1],
        ['_id', -1],
      ],
    ]);
  });
});
