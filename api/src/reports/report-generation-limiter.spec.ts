import {
  REPORT_GENERATION_BUSY,
  REPORT_GENERATION_LIMITS,
  REPORT_RATE_LIMITED,
  ReportGenerationLimiter,
  type ReportGenerationDecision,
} from './report-generation-limiter';

const limits = {
  windowMs: 60_000,
  maxPerWindow: 3,
  maxActiveGlobal: 2,
  maxActivePerOrganization: 1,
  busyRetryAfterSeconds: 7,
};

function admitted(d: ReportGenerationDecision): () => void {
  if (!d.admitted) throw new Error(`refusé : ${d.code}`);
  return d.release;
}

describe('1-16D — limiteur de génération des historiques', () => {
  let now = 0;
  const limiter = () => new ReportGenerationLimiter(limits, () => now);

  beforeEach(() => {
    now = 1_000_000;
  });

  it('paramètres de production centralisés et figés', () => {
    expect(Object.isFrozen(REPORT_GENERATION_LIMITS)).toBe(true);
    expect(
      REPORT_GENERATION_LIMITS.maxActivePerOrganization,
    ).toBeGreaterThanOrEqual(2); // Excel + PDF
    expect(new ReportGenerationLimiter().active).toBe(0);
  });

  it('quota par compte et commerce : 429 avec délai exact, puis réouverture', () => {
    const l = limiter();
    for (let i = 0; i < 3; i++) admitted(l.acquire('u1', 'o1'))();
    now += 20_000;
    expect(l.acquire('u1', 'o1')).toEqual({
      admitted: false,
      code: REPORT_RATE_LIMITED,
      retryAfterSeconds: 40,
    });
    // Autre compte, ou même compte dans un autre commerce : indépendants.
    admitted(l.acquire('u2', 'o1'))();
    admitted(l.acquire('u1', 'o2'))();
    now += 40_000;
    admitted(l.acquire('u1', 'o1'))();
  });

  it('simultanéité : 503 sans consommer le quota ; place rendue à la libération', () => {
    const l = limiter();
    const release = admitted(l.acquire('u1', 'o1'));
    expect(l.acquire('u2', 'o1')).toEqual({
      admitted: false,
      code: REPORT_GENERATION_BUSY,
      retryAfterSeconds: 7,
    });
    const other = admitted(l.acquire('u3', 'o2'));
    expect(l.acquire('u4', 'o3')).toMatchObject({
      code: REPORT_GENERATION_BUSY,
    });
    expect(l.active).toBe(2);
    release();
    release(); // idempotent
    other();
    expect(l.active).toBe(0);
    // Les refus de simultanéité n'ont rien consommé : u2 a encore 3 essais.
    for (let i = 0; i < 3; i++) admitted(l.acquire('u2', 'o1'))();
    expect(l.acquire('u2', 'o1')).toMatchObject({ code: REPORT_RATE_LIMITED });
  });

  it('libération après erreur (bloc finally)', () => {
    const l = limiter();
    const run = () => {
      const slot = l.acquire('u1', 'o1');
      try {
        throw new Error('échec de génération');
      } finally {
        if (slot.admitted) slot.release();
      }
    };
    expect(run).toThrow('échec de génération');
    expect(l.active).toBe(0);
    admitted(l.acquire('u1', 'o1'))();
  });
});
