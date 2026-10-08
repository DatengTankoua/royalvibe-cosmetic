import {
  configureProcessTimeZone,
  monthBounds,
  processTimeZone,
} from './month-range';

describe('1-16D — fuseau et bornes des mois', () => {
  it('sans TZ : fuseau inchangé', () => {
    const current = processTimeZone();
    expect(configureProcessTimeZone({})).toBe(current);
    expect(configureProcessTimeZone({ TZ: '  ' })).toBe(current);
  });

  it('TZ inconnu : démarrage refusé (jamais de repli silencieux en UTC)', () => {
    expect(() => configureProcessTimeZone({ TZ: 'Afrique/Douala' })).toThrow(
      'TZ invalide',
    );
  });

  it('TZ égal au fuseau effectif : accepté', () => {
    const current = processTimeZone();
    expect(configureProcessTimeZone({ TZ: current })).toBe(current);
  });

  it('bornes : 1er du mois 00:00 local, fin exclue', () => {
    const { start, end } = monthBounds('2026-12');
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([
      2026, 11, 1,
    ]);
    expect([end.getFullYear(), end.getMonth(), end.getHours()]).toEqual([
      2027, 0, 0,
    ]);
  });
});
