import { stockLowCrossed, stockLowReached } from './stock-thresholds';

describe('Seuil de 80 % consommé (1-16A.1)', () => {
  it('100 initiales : atteint à 20 restantes exactement, pas à 21', () => {
    expect(stockLowReached(100, 21)).toBe(false);
    expect(stockLowReached(100, 20)).toBe(true);
    expect(stockLowReached(100, 0)).toBe(true);
  });

  it('comparaison exacte, sans pourcentage arrondi', () => {
    // 3 initiales : 80 % = 2,4 consommées → atteint à 3 consommées seulement
    // (un arrondi de 66,7 % à 67 % ou de 2,4 à 2 donnerait un faux positif).
    expect(stockLowReached(3, 1)).toBe(false);
    expect(stockLowReached(3, 0)).toBe(true);
    // 7 initiales : 5,6 consommées requises.
    expect(stockLowReached(7, 2)).toBe(false);
    expect(stockLowReached(7, 1)).toBe(true);
    // 5 initiales : 4 consommées = 80 % exact.
    expect(stockLowReached(5, 1)).toBe(true);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'quantité initiale invalide (%s) : jamais atteint',
    (initial) => {
      expect(stockLowReached(initial, 0)).toBe(false);
    },
  );

  it('franchissement : avant non atteint, après atteint', () => {
    expect(stockLowCrossed(100, 25, 100, 20)).toBe(true);
    expect(stockLowCrossed(100, 20, 100, 15)).toBe(false); // déjà franchi
    expect(stockLowCrossed(100, 25, 100, 22)).toBe(false); // pas encore
    // Réapprovisionnement (+50 initial et restant) : repasse sous le seuil.
    expect(stockLowReached(150, 70)).toBe(false);
    expect(stockLowCrossed(150, 70, 150, 30)).toBe(true); // réarmé
  });
});
