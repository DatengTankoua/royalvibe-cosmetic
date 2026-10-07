import {
  assignPrimaryPriority,
  buildPriorities,
  changePercent,
  classifyStock,
  comparisonWindow,
  estimateSalesRate,
  localDayKey,
  noRecentSaleKind,
  observationWindow,
  pageOf,
  type ProductDayRow,
} from './insights';
import { INSIGHT_THRESHOLDS } from './insight-thresholds';

// Dates civiles construites dans le fuseau du processus, comme l'API.
const NOW = new Date(2026, 9, 7, 14, 5); // 7 octobre 2026, 14:05
const WINDOW = observationWindow(NOW);

const day = (offset: number) =>
  localDayKey(
    new Date(
      WINDOW.end.getFullYear(),
      WINDOW.end.getMonth(),
      WINDOW.end.getDate() + offset,
    ),
  );
const rows = (
  ...entries: Array<[offset: number, units: number, invalid?: number]>
): ProductDayRow[] =>
  entries.map(([offset, units, invalid]) => ({
    productId: 'p',
    day: day(offset),
    units,
    invalid: invalid ?? 0,
  }));

const old = new Date(2025, 0, 1);

describe('1-16E — fenêtre d’observation', () => {
  it('28 derniers jours civils terminés, aujourd’hui exclu', () => {
    expect(WINDOW.end).toEqual(new Date(2026, 9, 7));
    expect(WINDOW.start).toEqual(new Date(2026, 8, 9));
    expect(WINDOW.days).toBe(28);
  });
});

describe('1-16E — rythme des ventes et jours estimés', () => {
  it('moyenne = quantité / jours observés ; jours restants = stock / moyenne', () => {
    const e = estimateSalesRate({
      remainingQuantity: 3,
      window: WINDOW,
      productCreatedAt: old,
      organizationCreatedAt: old,
      days: rows([-1, 6], [-5, 4], [-20, 4]),
    });
    expect(e).toMatchObject({
      estimable: true,
      observedDays: 28,
      distinctSaleDays: 3,
      unitsSold: 14,
      dailyAverage: 0.5,
      daysLeft: 6,
    });
  });

  it('7 jours exacts : mis en évidence (aucune erreur d’arrondi)', () => {
    const e = estimateSalesRate({
      remainingQuantity: 1,
      window: WINDOW,
      productCreatedAt: old,
      days: rows([-1, 2], [-2, 1], [-3, 1]),
    });
    expect(e.estimable && e.daysLeft).toBe(7);
    expect(
      classifyStock({ remainingQuantity: 1, initialQuantity: 10 }, e),
    ).toBe('soon');
  });

  it('décision sur la valeur NON arrondie : 7,47 jours (affiché « 7 ») n’est pas mis en évidence', () => {
    const e = estimateSalesRate({
      remainingQuantity: 4,
      window: WINDOW,
      productCreatedAt: old,
      days: rows([-1, 5], [-2, 5], [-3, 5]),
    });
    expect(e.estimable && e.daysLeft).toBeCloseTo(7.4667, 3);
    // Stock faible au sens des 80 % (4/100) : ignoré quand l’estimation existe.
    expect(
      classifyStock({ remainingQuantity: 4, initialQuantity: 100 }, e),
    ).toBeNull();
  });

  it('observation à partir du jour d’ajout du produit (jour compris)', () => {
    const created = new Date(2026, 8, 17, 16, 0); // 20 jours avant le 7/10
    const e = estimateSalesRate({
      remainingQuantity: 10,
      window: WINDOW,
      productCreatedAt: created,
      organizationCreatedAt: old,
      // Vente antérieure à l’ajout (données migrées) : ignorée.
      days: rows([-25, 50], [-1, 4], [-2, 3], [-3, 3]),
    });
    expect(e).toMatchObject({
      estimable: true,
      observedDays: 20,
      unitsSold: 10,
    });
    expect(e.estimable && e.dailyAverage).toBe(0.5);
    expect(e.estimable && e.daysLeft).toBe(20);
  });

  it('observation à partir de la création du commerce', () => {
    const e = estimateSalesRate({
      remainingQuantity: 10,
      window: WINDOW,
      productCreatedAt: old,
      organizationCreatedAt: new Date(2026, 8, 22, 9, 0),
      days: rows([-1, 1], [-2, 1], [-3, 1]),
    });
    expect(e.observedDays).toBe(15);
  });

  it('moins de 14 jours d’observation : pas d’estimation (produit récent)', () => {
    const e = estimateSalesRate({
      remainingQuantity: 1,
      window: WINDOW,
      productCreatedAt: new Date(2026, 8, 25),
      days: rows([-1, 9], [-2, 9], [-3, 9], [-4, 9]),
    });
    expect(e).toMatchObject({
      estimable: false,
      reason: 'insufficient_history',
      observedDays: 12,
    });
  });

  it('ventes sur moins de 3 dates distinctes : pas d’estimation, repli sur le seuil 80 %', () => {
    const e = estimateSalesRate({
      remainingQuantity: 2,
      window: WINDOW,
      productCreatedAt: old,
      days: rows([-1, 40], [-2, 40]),
    });
    expect(e).toMatchObject({
      estimable: false,
      reason: 'insufficient_history',
      distinctSaleDays: 2,
    });
    expect(
      classifyStock({ remainingQuantity: 2, initialQuantity: 10 }, e),
    ).toBe('low');
    expect(
      classifyStock({ remainingQuantity: 3, initialQuantity: 10 }, e),
    ).toBeNull();
  });

  it('aucune vente : pas d’estimation (moyenne nulle)', () => {
    const e = estimateSalesRate({
      remainingQuantity: 5,
      window: WINDOW,
      productCreatedAt: old,
      days: [],
    });
    expect(e).toMatchObject({ estimable: false, unitsSold: 0 });
  });

  it('quantité invalide : aucune estimation', () => {
    const e = estimateSalesRate({
      remainingQuantity: 5,
      window: WINDOW,
      productCreatedAt: old,
      days: rows([-1, 3], [-2, 3, 1], [-3, 3]),
    });
    expect(e).toMatchObject({ estimable: false, reason: 'invalid_quantities' });
    const nan = estimateSalesRate({
      remainingQuantity: 5,
      window: WINDOW,
      productCreatedAt: old,
      days: rows([-1, 3], [-2, Number.NaN], [-3, 3]),
    });
    expect(nan).toMatchObject({
      estimable: false,
      reason: 'invalid_quantities',
    });
  });

  it('ventes d’aujourd’hui (jour non terminé) hors fenêtre', () => {
    const e = estimateSalesRate({
      remainingQuantity: 5,
      window: WINDOW,
      productCreatedAt: old,
      days: rows([0, 100], [-1, 1], [-2, 1], [-3, 1]),
    });
    expect(e.unitsSold).toBe(3);
  });

  it('stock nul : rupture constatée, quelle que soit l’estimation', () => {
    const e = estimateSalesRate({
      remainingQuantity: 0,
      window: WINDOW,
      productCreatedAt: old,
      days: [],
    });
    expect(classifyStock({ remainingQuantity: 0, initialQuantity: 5 }, e)).toBe(
      'out',
    );
  });
});

describe('1-16E — produits sans vente récente', () => {
  const base = { windowStart: WINDOW.start, remainingQuantity: 4 };
  it('ajouté avant la fenêtre, stock positif, aucune vente → stale', () => {
    expect(
      noRecentSaleKind({ ...base, productCreatedAt: old, salesInWindow: 0 }),
    ).toBe('stale');
  });
  it('ajouté pendant la fenêtre → recent (distingué)', () => {
    expect(
      noRecentSaleKind({
        ...base,
        productCreatedAt: new Date(2026, 9, 1),
        salesInWindow: 0,
      }),
    ).toBe('recent');
  });
  it('vendu sur la fenêtre ou stock nul → rien', () => {
    expect(
      noRecentSaleKind({ ...base, productCreatedAt: old, salesInWindow: 1 }),
    ).toBeNull();
    expect(
      noRecentSaleKind({
        ...base,
        remainingQuantity: 0,
        productCreatedAt: old,
        salesInWindow: 0,
      }),
    ).toBeNull();
  });
});

describe('1-16E — périodes comparables', () => {
  it('mois en cours : même durée écoulée du mois précédent', () => {
    const w = comparisonWindow('2026-10', NOW, old);
    expect(w).toEqual({
      available: true,
      partial: true,
      start: new Date(2026, 8, 1),
      end: new Date(
        new Date(2026, 8, 1).getTime() +
          (NOW.getTime() - new Date(2026, 9, 1).getTime()),
      ),
    });
  });

  it('mois terminé : mois précédent entier', () => {
    expect(comparisonWindow('2026-08', NOW, old)).toEqual({
      available: true,
      partial: false,
      month: '2026-07',
      start: new Date(2026, 6, 1),
      end: new Date(2026, 7, 1),
    });
  });

  it('janvier → décembre de l’année précédente', () => {
    const w = comparisonWindow('2026-01', NOW, old);
    expect(w.available && w.month).toBe('2025-12');
  });

  it('30 mars en cours : février plus court, aucune comparaison', () => {
    const w = comparisonWindow('2026-03', new Date(2026, 2, 30, 10), old);
    expect(w).toMatchObject({ available: false, reason: 'unequal_length' });
  });

  it('période précédente antérieure à la création du commerce : aucune comparaison', () => {
    const w = comparisonWindow('2026-10', NOW, new Date(2026, 8, 10));
    expect(w).toMatchObject({ available: false, reason: 'before_creation' });
  });

  it('période précédente à zéro : aucun pourcentage', () => {
    expect(changePercent(5000, 0)).toBeNull();
    expect(changePercent(0, 0)).toBeNull();
    expect(changePercent(150, 100)).toBe(50);
    expect(changePercent(50, 100)).toBe(-50);
  });
});

describe('1-16E — cartes « À surveiller »', () => {
  const item = (productId: string) => ({ productId });
  it('ordre de gravité, au plus 3 cartes, un produit dans une seule carte', () => {
    const cards = buildPriorities({
      out: [item('a')],
      soon: [item('b'), item('c')],
      price: [item('a'), item('d')],
      low: [item('e')],
      stale: [item('f')],
    });
    expect(cards.map((c) => c.kind)).toEqual(['out', 'soon', 'price']);
    expect(cards[2]).toEqual({ kind: 'price', count: 1, items: [item('d')] });
  });

  it('une carte vidée par le dédoublonnage n’est pas affichée', () => {
    const cards = buildPriorities({
      out: [item('a')],
      price: [item('a')],
      stale: [item('z')],
    });
    expect(cards.map((c) => c.kind)).toEqual(['out', 'stale']);
  });

  it('aucun signal : aucune carte', () => {
    expect(buildPriorities({})).toEqual([]);
  });

  it('seuils documentés et centralisés', () => {
    expect(INSIGHT_THRESHOLDS).toMatchObject({
      observationWindowDays: 28,
      minObservationDays: 14,
      minDistinctSaleDays: 3,
      soonStockoutDays: 7,
      maxPriorities: 3,
      topProducts: 5,
    });
    expect(Object.isFrozen(INSIGHT_THRESHOLDS)).toBe(true);
  });
});

describe('1-16E — priorité unique et pages', () => {
  const item = (productId: string) => ({ productId });
  it('chaque produit dans la seule liste la plus grave, ordre conservé', () => {
    const lists = assignPrimaryPriority({
      out: [item('a')],
      soon: [item('b')],
      price: [item('c'), item('a'), item('b')],
      low: [item('e'), item('c')],
      stale: [item('f'), item('e')],
    });
    expect(lists).toEqual({
      out: [item('a')],
      soon: [item('b')],
      price: [item('c')],
      low: [item('e')],
      stale: [item('f')],
    });
  });

  it('carte : décompte de la liste à priorité unique, aperçu d’un seul produit', () => {
    const many = Array.from({ length: 63 }, (_, i) => item(`p${i}`));
    const [card] = buildPriorities({ out: many });
    expect(card).toEqual({ kind: 'out', count: 63, items: [item('p0')] });
  });

  it('pages contiguës : ni doublon ni omission, total constant', () => {
    const all = Array.from({ length: 63 }, (_, i) => i);
    const first = pageOf(all, 0, 50);
    const second = pageOf(all, 50, 50);
    expect(first).toMatchObject({ count: 63, offset: 0, limit: 50 });
    expect([...first.items, ...second.items]).toEqual(all);
    expect(pageOf(all, 100, 50).items).toEqual([]);
  });
});
