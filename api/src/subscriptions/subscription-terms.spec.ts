import {
  SubscriptionPeriodKind,
  SubscriptionPeriodSnapshot,
  SubscriptionTerm,
  TRIAL_DURATION_MS,
  addUtcMonthsClamped,
  computeRenewalStartsAt,
  computeSubscriptionEndsAt,
  computeSubscriptionState,
  computeTrialEndsAt,
  isSubscriptionTerm,
  trialSourceReference,
} from './subscription-terms';

const d = (iso: string) => new Date(iso);

function period(
  sequence: number,
  startsAt: string,
  endsAt: string,
  kind = SubscriptionPeriodKind.SUBSCRIPTION,
  term: SubscriptionTerm | null = SubscriptionTerm.MONTHLY,
): SubscriptionPeriodSnapshot {
  return { sequence, kind, term, startsAt: d(startsAt), endsAt: d(endsAt) };
}

describe('subscription-terms (1-14B)', () => {
  describe('essai', () => {
    it('exactement 7 × 24 h', () => {
      expect(TRIAL_DURATION_MS).toBe(604_800_000);
      const start = d('2026-03-28T10:15:30.123Z');
      expect(computeTrialEndsAt(start).getTime() - start.getTime()).toBe(
        604_800_000,
      );
    });

    it('référence déterministe liée à l’organisation', () => {
      expect(trialSourceReference('a'.repeat(24))).toBe(
        `trial:${'a'.repeat(24)}`,
      );
    });
  });

  describe('durées calendaires UTC', () => {
    it.each([
      [
        SubscriptionTerm.MONTHLY,
        '2026-01-15T08:00:00.000Z',
        '2026-02-15T08:00:00.000Z',
      ],
      [
        SubscriptionTerm.QUARTERLY,
        '2026-01-15T08:00:00.000Z',
        '2026-04-15T08:00:00.000Z',
      ],
      [
        SubscriptionTerm.SEMIANNUAL,
        '2026-01-15T08:00:00.000Z',
        '2026-07-15T08:00:00.000Z',
      ],
      [
        SubscriptionTerm.ANNUAL,
        '2026-01-15T08:00:00.000Z',
        '2027-01-15T08:00:00.000Z',
      ],
    ])('%s : %s → %s', (term, start, end) => {
      expect(computeSubscriptionEndsAt(d(start), term).toISOString()).toBe(end);
    });

    it.each([
      ['2026-01-31T12:00:00.000Z', 1, '2026-02-28T12:00:00.000Z'],
      ['2028-01-31T12:00:00.000Z', 1, '2028-02-29T12:00:00.000Z'],
      ['2028-02-29T00:00:00.000Z', 12, '2029-02-28T00:00:00.000Z'],
      ['2028-02-29T00:00:00.000Z', 48, '2032-02-29T00:00:00.000Z'],
      ['2026-08-31T23:59:59.999Z', 6, '2027-02-28T23:59:59.999Z'],
      ['2026-11-30T00:00:00.000Z', 3, '2027-02-28T00:00:00.000Z'],
      ['2026-12-31T00:00:00.000Z', 1, '2027-01-31T00:00:00.000Z'],
      ['2026-05-31T00:00:00.000Z', 1, '2026-06-30T00:00:00.000Z'],
    ])('fin de mois ramenée : %s + %i mois → %s', (start, months, end) => {
      expect(addUtcMonthsClamped(d(start), months).toISOString()).toBe(end);
    });

    it('indépendant du fuseau du processus (calcul UTC)', () => {
      const original = process.env.TZ;
      try {
        process.env.TZ = 'Pacific/Kiritimati';
        const end = computeSubscriptionEndsAt(
          d('2026-01-31T23:30:00.000Z'),
          SubscriptionTerm.MONTHLY,
        );
        expect(end.toISOString()).toBe('2026-02-28T23:30:00.000Z');
      } finally {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
      }
    });

    it('enum fermé', () => {
      expect(isSubscriptionTerm('annual')).toBe(true);
      expect(isSubscriptionTerm('weekly')).toBe(false);
      expect(isSubscriptionTerm(undefined)).toBe(false);
      expect(isSubscriptionTerm('ANNUAL')).toBe(false);
    });
  });

  describe('début de renouvellement', () => {
    const now = d('2026-06-10T00:00:00.000Z');

    it('couverture future → prolonge à partir de sa fin', () => {
      expect(
        computeRenewalStartsAt(
          now,
          d('2026-07-01T00:00:00.000Z'),
        ).toISOString(),
      ).toBe('2026-07-01T00:00:00.000Z');
    });

    it('couverture terminée ou absente → maintenant', () => {
      expect(
        computeRenewalStartsAt(
          now,
          d('2026-05-01T00:00:00.000Z'),
        ).toISOString(),
      ).toBe(now.toISOString());
      expect(computeRenewalStartsAt(now, now).toISOString()).toBe(
        now.toISOString(),
      );
      expect(computeRenewalStartsAt(now, null).toISOString()).toBe(
        now.toISOString(),
      );
    });
  });

  describe('état', () => {
    const trial = period(
      1,
      '2026-01-01T00:00:00.000Z',
      '2026-01-08T00:00:00.000Z',
      SubscriptionPeriodKind.TRIAL,
      null,
    );

    it('none : aucune période', () => {
      expect(computeSubscriptionState([], d('2026-01-01T00:00:00Z'))).toEqual({
        state: 'none',
        currentPeriod: null,
        coverageEndsAt: null,
        nextPeriodStartsAt: null,
      });
    });

    it('bornes : startsAt inclus, endsAt exclu', () => {
      expect(
        computeSubscriptionState([trial], d('2025-12-31T23:59:59.999Z')).state,
      ).toBe('scheduled');
      expect(
        computeSubscriptionState([trial], d('2026-01-01T00:00:00.000Z')).state,
      ).toBe('active');
      expect(
        computeSubscriptionState([trial], d('2026-01-07T23:59:59.999Z')).state,
      ).toBe('active');
      const after = computeSubscriptionState(
        [trial],
        d('2026-01-08T00:00:00.000Z'),
      );
      expect(after.state).toBe('expired');
      expect(after.currentPeriod).toBeNull();
      expect(after.coverageEndsAt?.toISOString()).toBe(
        '2026-01-08T00:00:00.000Z',
      );
    });

    it('période courante + fin de couverture continue (renouvellements futurs)', () => {
      const p2 = period(
        2,
        '2026-01-08T00:00:00.000Z',
        '2026-02-08T00:00:00.000Z',
      );
      const p3 = period(
        3,
        '2026-02-08T00:00:00.000Z',
        '2026-05-08T00:00:00.000Z',
        SubscriptionPeriodKind.SUBSCRIPTION,
        SubscriptionTerm.QUARTERLY,
      );
      const view = computeSubscriptionState(
        [p3, trial, p2],
        d('2026-01-03T00:00:00.000Z'),
      );
      expect(view.state).toBe('active');
      expect(view.currentPeriod).toEqual({
        kind: SubscriptionPeriodKind.TRIAL,
        term: null,
        startsAt: trial.startsAt,
        endsAt: trial.endsAt,
      });
      expect(view.coverageEndsAt?.toISOString()).toBe(
        '2026-05-08T00:00:00.000Z',
      );

      const later = computeSubscriptionState(
        [p3, trial, p2],
        d('2026-02-08T00:00:00.000Z'),
      );
      expect(later.currentPeriod?.term).toBe(SubscriptionTerm.QUARTERLY);
    });

    it('trou dans la couverture : la continuité s’arrête au trou', () => {
      const p2 = period(
        2,
        '2026-03-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z',
      );
      const view = computeSubscriptionState(
        [trial, p2],
        d('2026-01-02T00:00:00.000Z'),
      );
      expect(view.coverageEndsAt?.toISOString()).toBe(
        '2026-01-08T00:00:00.000Z',
      );

      const between = computeSubscriptionState(
        [trial, p2],
        d('2026-02-01T00:00:00.000Z'),
      );
      expect(between.state).toBe('scheduled');
      expect(between.currentPeriod).toBeNull();
      expect(between.nextPeriodStartsAt?.toISOString()).toBe(
        '2026-03-01T00:00:00.000Z',
      );
      expect(between.coverageEndsAt?.toISOString()).toBe(
        '2026-04-01T00:00:00.000Z',
      );
    });

    it('expired : fin de la dernière période', () => {
      const p2 = period(
        2,
        '2026-01-08T00:00:00.000Z',
        '2026-02-08T00:00:00.000Z',
      );
      const view = computeSubscriptionState(
        [p2, trial],
        d('2027-01-01T00:00:00.000Z'),
      );
      expect(view).toEqual({
        state: 'expired',
        currentPeriod: null,
        coverageEndsAt: d('2026-02-08T00:00:00.000Z'),
        nextPeriodStartsAt: null,
      });
    });
  });
});
