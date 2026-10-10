import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import {
  PRODUCT_PAGE_INDEXES,
  PRODUCT_PAGE_MAX_LIMIT,
  decodeProductPageCursor,
  encodeProductPageCursor,
  parseProductPageQuery,
  productNameSearch,
  productPageFilter,
} from './product-page';

describe('Liste paginée des produits (1-20F)', () => {
  it('curseur : aller-retour exact (date à la milliseconde, identifiant)', () => {
    const product = {
      createdAt: new Date('2026-09-01T10:00:00.123Z'),
      _id: new Types.ObjectId(),
    };
    const cursor = encodeProductPageCursor(product);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = decodeProductPageCursor(cursor);
    expect(back.createdAt.getTime()).toBe(product.createdAt.getTime());
    expect(back.id.equals(product._id)).toBe(true);
  });

  it('curseur : jamais fabriqué sans createdAt', () => {
    expect(() =>
      encodeProductPageCursor({ _id: new Types.ObjectId(), createdAt: null }),
    ).toThrow();
  });

  it.each([
    ['vide', ''],
    ['base64 illisible', '%%%'],
    ['pas un tableau', Buffer.from('{"a":1}').toString('base64url')],
    [
      'identifiant invalide',
      Buffer.from('["2026-01-01T00:00:00Z","zz"]').toString('base64url'),
    ],
    [
      'date invalide',
      Buffer.from(`["x","${'0'.repeat(24)}"]`).toString('base64url'),
    ],
    ['trop long', 'a'.repeat(201)],
  ])('curseur %s → 400', (_label, value) => {
    expect(() => decodeProductPageCursor(value)).toThrow(BadRequestException);
  });

  it('sans `limit` : ancien contrat (undefined) ; `cursor`/`q` seuls refusés', () => {
    expect(parseProductPageQuery({})).toBeUndefined();
    expect(() => parseProductPageQuery({ q: 'a' })).toThrow(
      BadRequestException,
    );
    expect(() => parseProductPageQuery({ cursor: 'a' })).toThrow(
      BadRequestException,
    );
  });

  it.each([
    ['0', false],
    ['1', true],
    [String(PRODUCT_PAGE_MAX_LIMIT), true],
    [String(PRODUCT_PAGE_MAX_LIMIT + 1), false],
    ['1.5', false],
    ['-1', false],
    ['abc', false],
    [['10', '20'], false],
  ])('limit %p → valide : %p', (limit, ok) => {
    const run = () => parseProductPageQuery({ limit });
    if (ok) expect(run()).toEqual({ limit: Number(limit) });
    else expect(run).toThrow(BadRequestException);
  });

  it('recherche : texte tel que saisi ; vide ou trop long refusé', () => {
    expect(parseProductPageQuery({ limit: '5', q: ' Sav ' })).toEqual({
      limit: 5,
      search: ' Sav ',
    });
    for (const q of ['', '   ', 'x'.repeat(201), ['a', 'b']]) {
      expect(() => parseProductPageQuery({ limit: '5', q })).toThrow(
        BadRequestException,
      );
    }
  });

  it('recherche : motif littéral, casse ignorée, accents distingués', () => {
    const re = productNameSearch('a.b (x)*');
    expect(re.test('PRIX A.B (X)* lot')).toBe(true);
    expect(re.test('Prix axb (x)')).toBe(false);
    expect(productNameSearch('éclair').test('ÉCLAIR')).toBe(true);
    expect(productNameSearch('eclair').test('Éclair')).toBe(false);
  });

  it('filtre de page : borne `createdAt ≤` et départage par `_id`', () => {
    const cursor = {
      createdAt: new Date('2026-09-01T00:00:00Z'),
      id: new Types.ObjectId(),
    };
    expect(productPageFilter({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(productPageFilter({ a: 1 }, cursor)).toEqual({
      a: 1,
      createdAt: { $lte: cursor.createdAt },
      $or: [
        { createdAt: { $lt: cursor.createdAt } },
        { _id: { $lt: cursor.id } },
      ],
    });
  });

  it('index : égalités puis tri de la page', () => {
    expect(PRODUCT_PAGE_INDEXES.map((i) => Object.entries(i.key))).toEqual([
      [
        ['organizationId', 1],
        ['sectionId', 1],
        ['deletedAt', 1],
        ['createdAt', -1],
        ['_id', -1],
      ],
    ]);
  });
});
