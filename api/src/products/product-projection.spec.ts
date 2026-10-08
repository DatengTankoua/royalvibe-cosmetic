import { Types } from 'mongoose';
import {
  COMMON_VISIBILITY,
  toProductMetricsView,
  toProductView,
} from './product-projection';

const SOURCE = {
  _id: new Types.ObjectId('223344556677889900112233'),
  sectionId: new Types.ObjectId('112233445566778899001122'),
  name: 'Prod',
  // Champs de stockage : jamais projetés tels quels (l'URL est fournie).
  imageUrl: 'http://ancien/p.png',
  imageKey: 'organizations/aaaaaaaaaaaaaaaaaaaaaaaa/products/k.jpg',
  imageStorage: 'r2/stockmaster-prod',
  purchasePrice: 1000,
  salePrice: 1500,
  initialQuantity: 10,
  remainingQuantity: 5,
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  // Champs internes jamais projetés :
  organizationId: new Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'),
  __v: 0,
};

const SIGNED = 'https://signed.example/k.jpg?X-Amz-Expires=900';

const STANDARD_PRODUCT_KEYS = [
  '_id',
  'createdAt',
  'deletedAt',
  'imageUrl',
  'name',
  'remainingQuantity',
  'salePrice',
  'sectionId',
  'updatedAt',
];

/** Projection exacte (1-12H) : allowlist par groupe, rien d'autre. */
describe('projection produit (1-12H)', () => {
  it.each([
    [
      'standard',
      COMMON_VISIBILITY,
      STANDARD_PRODUCT_KEYS,
      ['product', 'status'],
    ],
    [
      'détail du stock',
      { stockDetails: true, financials: false },
      [...STANDARD_PRODUCT_KEYS, 'initialQuantity'],
      ['product', 'status', 'unitsSold'],
    ],
    [
      'finances',
      { stockDetails: false, financials: true },
      [...STANDARD_PRODUCT_KEYS, 'purchasePrice'],
      [
        'actualProfit',
        'actualRevenue',
        'margin',
        'product',
        'status',
        'totalPurchaseCost',
      ],
    ],
    [
      'deux groupes',
      { stockDetails: true, financials: true },
      [...STANDARD_PRODUCT_KEYS, 'initialQuantity', 'purchasePrice'],
      [
        'actualProfit',
        'actualRevenue',
        'margin',
        'product',
        'status',
        'totalPurchaseCost',
        'unitsSold',
      ],
    ],
  ])('%s : clés exactes', (_label, visibility, productKeys, metricKeys) => {
    const view = toProductMetricsView(SOURCE, visibility, SIGNED, 9000);
    expect(Object.keys(view).sort()).toEqual([...metricKeys].sort());
    expect(Object.keys(view.product).sort()).toEqual([...productKeys].sort());
    expect(
      Object.keys(toProductView(SOURCE, visibility, SIGNED)).sort(),
    ).toEqual([...productKeys].sort());
  });

  it('URL de photo : celle fournie par le service, jamais la clé, le stockage ni l’ancienne URL du document', () => {
    const view = toProductView(SOURCE, COMMON_VISIBILITY, SIGNED);
    expect(view.imageUrl).toBe(SIGNED);
    expect(JSON.stringify(view)).not.toContain('imageKey');
    expect(JSON.stringify(view)).not.toContain('r2/stockmaster-prod');
    expect(toProductView(SOURCE, COMMON_VISIBILITY, null).imageUrl).toBeNull();
  });

  it('formules conservées : CA réel fourni, bénéfice = CA − achat × vendus, marge = bénéfice / CA, coût = achat × initial', () => {
    const view = toProductMetricsView(
      SOURCE,
      { stockDetails: true, financials: true },
      SIGNED,
      9000,
    );
    expect(view.unitsSold).toBe(5);
    expect(view.actualRevenue).toBe(9000);
    expect(view.actualProfit).toBe(9000 - 1000 * 5);
    expect(view.margin).toBeCloseTo((4000 / 9000) * 100);
    expect(view.totalPurchaseCost).toBe(10000);
  });

  it('CA nul : marge null (non calculable), jamais une valeur inventée', () => {
    const view = toProductMetricsView(
      SOURCE,
      { stockDetails: false, financials: true },
      SIGNED,
      0,
    );
    expect(view.margin).toBeNull();
  });
});
