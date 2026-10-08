import {
  SUBSCRIPTION_PRICES_XAF,
  SUBSCRIPTION_PRICING_CURRENCY,
  SUBSCRIPTION_PRICING_VERSION,
  SubscriptionPricingError,
  getSubscriptionPrice,
  listSubscriptionPrices,
} from './subscription-pricing';
import { SubscriptionTerm, TERM_MONTHS } from './subscription-terms';
// Parité UNIQUEMENT (test) : le code de production n'importe jamais le web.
// Import du module réel (aucune extraction par regex) : il exécute aussi sa
// propre vérification de cohérence.
import * as webOffers from '../../../web/src/lib/subscription-offers';

describe('Catalogue tarifaire serveur (1-14D.2A)', () => {
  it('quatre durées, montants totaux attendus, XAF, version explicite', () => {
    expect(SUBSCRIPTION_PRICING_VERSION).toBe(1);
    expect(SUBSCRIPTION_PRICING_CURRENCY).toBe('XAF');
    expect(
      listSubscriptionPrices().map((p) => [p.term, p.amount, p.months]),
    ).toEqual([
      ['monthly', 3000, 1],
      ['quarterly', 8500, 3],
      ['semiannual', 16000, 6],
      ['annual', 30000, 12],
    ]);
  });

  it('prix d’une durée : montant, devise, version et mois cohérents avec TERM_MONTHS', () => {
    for (const term of Object.values(SubscriptionTerm)) {
      const price = getSubscriptionPrice(term);
      expect(price).toEqual({
        term,
        months: TERM_MONTHS[term],
        amount: SUBSCRIPTION_PRICES_XAF[term],
        currency: 'XAF',
        pricingVersion: SUBSCRIPTION_PRICING_VERSION,
      });
      expect(Number.isSafeInteger(price.amount)).toBe(true);
      expect(price.amount).toBeGreaterThan(0);
    }
  });

  it.each([
    'weekly',
    'MONTHLY',
    ' monthly',
    '',
    null,
    undefined,
    1,
    3000,
    { term: 'monthly' },
    ['monthly'],
    'toString',
    '__proto__',
  ])('durée inconnue %p → refusée', (term) => {
    expect(() => getSubscriptionPrice(term)).toThrow(SubscriptionPricingError);
  });

  it('aucun montant libre : la seule entrée est la durée', () => {
    expect(getSubscriptionPrice.length).toBe(1);
    // Un argument supplémentaire (montant forgé) est sans effet.
    const forged = (getSubscriptionPrice as (...args: unknown[]) => unknown)(
      'monthly',
      1,
    );
    expect(forged).toMatchObject({ amount: 3000 });
  });

  it('valeurs immuables : catalogue, prix renvoyés et liste', () => {
    expect(Object.isFrozen(SUBSCRIPTION_PRICES_XAF)).toBe(true);
    expect(() => {
      (SUBSCRIPTION_PRICES_XAF as Record<string, number>).monthly = 1;
    }).toThrow(TypeError);
    const price = getSubscriptionPrice('annual');
    expect(Object.isFrozen(price)).toBe(true);
    expect(() => {
      (price as { amount: number }).amount = 1;
    }).toThrow(TypeError);
    const list = listSubscriptionPrices();
    expect(Object.isFrozen(list)).toBe(true);
    expect(getSubscriptionPrice('annual').amount).toBe(30000);
  });

  describe('parité avec le catalogue d’affichage web', () => {
    it('mêmes durées, même ordre, mêmes mois et mêmes montants totaux', () => {
      expect(
        webOffers.SUBSCRIPTION_OFFERS.map((o) => ({
          term: o.term,
          months: o.months,
          amount: o.totalXaf,
        })),
      ).toEqual(
        listSubscriptionPrices().map((p) => ({
          term: p.term,
          months: p.months,
          amount: p.amount,
        })),
      );
    });

    it('prix mensuel de référence identique au tarif mensuel serveur', () => {
      expect(webOffers.MONTHLY_PRICE_XAF).toBe(
        getSubscriptionPrice('monthly').amount,
      );
    });
  });
});
