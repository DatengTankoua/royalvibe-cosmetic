import { Types } from 'mongoose';
import {
  previousReportPeriod,
  sellersOfMonth,
  topProducts,
} from './monthly-report.service';
import {
  NOTIFICATION_RETENTION_AFTER_READ_MS,
  expiresAfterRead,
} from './notification-retention';
import {
  PUSH_CATEGORIES,
  PushCategory,
  accessibleCategories,
  canAccessCategory,
} from '../push/schemas/push-category';
import { OrganizationRole } from '../organizations/permissions';

const id = () => new Types.ObjectId();
const row = (name: string, units: number, deleted = false) => ({
  productId: id(),
  productName: name,
  productDeleted: deleted,
  totalUnitsSold: units,
  transactionCount: 1,
});

describe('Bilan mensuel — règles (1-16A.1)', () => {
  it('mois précédent dans le fuseau du processus, comme `monthMatch`', () => {
    const range = previousReportPeriod(new Date(2026, 9, 1, 0, 5));
    expect(range.period).toBe('2026-09');
    expect(range.start).toEqual(new Date(2026, 8, 1));
    expect(range.end).toEqual(new Date(2026, 9, 1));
    expect(previousReportPeriod(new Date(2027, 0, 15)).period).toBe('2026-12');
  });

  it('top 5 par quantité nette ; ex æquo du 5e rang inclus ; aucune vente exclue', () => {
    const rows = [
      row('A', 10),
      row('B', 8),
      row('C', 8),
      row('D', 5),
      row('E', 3),
      row('F', 3),
      row('G', 1),
      row('Z', 0),
    ];
    const top = topProducts(rows);
    expect(top.map((p) => [p.name, p.units])).toEqual([
      ['A', 10],
      ['B', 8],
      ['C', 8],
      ['D', 5],
      ['E', 3],
      ['F', 3],
    ]);
    expect(topProducts([row('X', 0)])).toEqual([]);
  });

  it('produit purgé : nom historique conservé et signalé', () => {
    const [purged] = topProducts([row('Ancien nom', 4, true)]);
    expect(purged).toMatchObject({ name: 'Ancien nom', deleted: true });
  });

  it('vendeur du mois : tous les ex æquo ; aucun sans vente', () => {
    const seller = (name: string, revenue: number) => ({
      sellerId: id(),
      sellerName: name,
      totalRevenue: revenue,
      totalUnitsSold: 1,
    });
    expect(
      sellersOfMonth([
        seller('Bea', 900),
        seller('Ali', 900),
        seller('Cyr', 100),
      ]).map((s) => s.name),
    ).toEqual(['Ali', 'Bea']);
    expect(sellersOfMonth([])).toEqual([]);
  });
});

describe('Rétention après lecture (1-16A.1)', () => {
  const read = new Date('2026-10-06T10:00:00Z');
  it.each([
    [PushCategory.SALE_CREATED, 48],
    [PushCategory.STOCK_LOW, 7 * 24],
    [PushCategory.MONTHLY_REPORT, 7 * 24],
    [PushCategory.STOCK_DEPLETED, 30 * 24],
    [PushCategory.SUBSCRIPTION_ENDING, 30 * 24],
    [PushCategory.PAYMENT_SUCCEEDED, 30 * 24],
  ])('%s : %i h après lecture', (category, hours) => {
    expect(expiresAfterRead(category, read).getTime() - read.getTime()).toBe(
      hours * 3600 * 1000,
    );
  });

  it('toutes les catégories visibles ont une durée', () => {
    for (const c of PUSH_CATEGORIES) {
      expect(
        NOTIFICATION_RETENTION_AFTER_READ_MS[
          c as keyof typeof NOTIFICATION_RETENTION_AFTER_READ_MS
        ],
      ).toBeGreaterThan(0);
    }
  });
});

describe('Droits par catégorie (1-16A.1)', () => {
  it('propriétaire : toutes ; administrateur : sans échéance ni paiement ; vendeur : aucune par défaut', () => {
    expect(
      accessibleCategories({ role: OrganizationRole.OWNER, permissions: [] }),
    ).toEqual([...PUSH_CATEGORIES]);
    expect(
      accessibleCategories({ role: OrganizationRole.ADMIN, permissions: [] }),
    ).toEqual([
      PushCategory.STOCK_DEPLETED,
      PushCategory.STOCK_LOW,
      PushCategory.SALE_CREATED,
      PushCategory.MONTHLY_REPORT,
    ]);
    expect(
      accessibleCategories({ role: OrganizationRole.SELLER, permissions: [] }),
    ).toEqual([]);
  });

  it('vendeur : stock et bilan par permission, jamais les ventes de tous', () => {
    const seller = {
      role: OrganizationRole.SELLER,
      permissions: [
        'products.view_stock_details',
        'analytics.read',
        'sales.view_all',
      ] as const,
    };
    expect(canAccessCategory(PushCategory.STOCK_LOW, seller)).toBe(true);
    expect(canAccessCategory(PushCategory.MONTHLY_REPORT, seller)).toBe(true);
    // Notification de vente : propriétaire ou administrateur seulement.
    expect(canAccessCategory(PushCategory.SALE_CREATED, seller)).toBe(false);
    expect(canAccessCategory(PushCategory.PAYMENT_SUCCEEDED, seller)).toBe(
      false,
    );
  });
});
