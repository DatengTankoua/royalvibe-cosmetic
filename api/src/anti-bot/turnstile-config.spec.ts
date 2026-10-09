import {
  TURNSTILE_DEFAULT_TIMEOUT_MS,
  TurnstileConfigError,
  isSimulationAllowed,
  resolveTurnstileConfig,
} from './turnstile-config';

const PROD = {
  NODE_ENV: 'production',
  PUBLIC_APP_URL: 'https://www.stock-master.app',
  CORS_ORIGIN: 'https://www.stock-master.app',
};
const SECRET = '0x4AAAAAAAfictitious-production-secret';
const TEST_SECRET = '1x0000000000000000000000000000000AA';

describe('1-18C — configuration Turnstile', () => {
  it('sans clé : non configuré (inscription refusée, jamais permissive)', () => {
    expect(resolveTurnstileConfig({ ...PROD })).toEqual({
      mode: 'unconfigured',
    });
  });

  it('production : clé + hôtes exacts, délai par défaut borné', () => {
    expect(
      resolveTurnstileConfig({
        ...PROD,
        TURNSTILE_SECRET_KEY: ` ${SECRET} `,
        TURNSTILE_ALLOWED_HOSTNAMES: 'www.stock-master.app, Stock-Master.app',
      }),
    ).toEqual({
      mode: 'cloudflare',
      secret: SECRET,
      hostnames: ['www.stock-master.app', 'stock-master.app'],
      timeoutMs: TURNSTILE_DEFAULT_TIMEOUT_MS,
      testKeys: false,
    });
  });

  it.each([
    [
      'clé de test Cloudflare en production',
      {
        TURNSTILE_SECRET_KEY: TEST_SECRET,
        TURNSTILE_ALLOWED_HOSTNAMES: 'www.stock-master.app',
      },
    ],
    ['clé sans hôtes autorisés', { TURNSTILE_SECRET_KEY: SECRET }],
    [
      'hôte local en production',
      {
        TURNSTILE_SECRET_KEY: SECRET,
        TURNSTILE_ALLOWED_HOSTNAMES: 'localhost',
      },
    ],
    [
      'hôte avec schéma',
      {
        TURNSTILE_SECRET_KEY: SECRET,
        TURNSTILE_ALLOWED_HOSTNAMES: 'https://www.stock-master.app',
      },
    ],
    [
      'hôte avec port',
      {
        TURNSTILE_SECRET_KEY: SECRET,
        TURNSTILE_ALLOWED_HOSTNAMES: 'www.stock-master.app:443',
      },
    ],
    [
      'hôte en double',
      {
        TURNSTILE_SECRET_KEY: SECRET,
        TURNSTILE_ALLOWED_HOSTNAMES: 'a.example,a.example',
      },
    ],
    [
      'délai hors bornes',
      {
        TURNSTILE_SECRET_KEY: SECRET,
        TURNSTILE_ALLOWED_HOSTNAMES: 'a.example',
        TURNSTILE_TIMEOUT_MS: '60000',
      },
    ],
    [
      'délai non entier',
      {
        TURNSTILE_SECRET_KEY: SECRET,
        TURNSTILE_ALLOWED_HOSTNAMES: 'a.example',
        TURNSTILE_TIMEOUT_MS: '1.5',
      },
    ],
    [
      'simulation avec origine publique (production)',
      { TURNSTILE_SIMULATED: 'true' },
    ],
    [
      'simulation et clé ensemble',
      { TURNSTILE_SIMULATED: 'true', TURNSTILE_SECRET_KEY: SECRET },
    ],
    ['simulation : valeur ambiguë', { TURNSTILE_SIMULATED: 'yes' }],
  ])('refus au démarrage : %s', (_label, extra) => {
    expect(() =>
      resolveTurnstileConfig({ ...PROD, ...(extra as Record<string, string>) }),
    ).toThrow(TurnstileConfigError);
  });

  it.each([
    [
      'origines publiques',
      {
        PUBLIC_APP_URL: 'https://www.stock-master.app',
        CORS_ORIGIN: 'https://www.stock-master.app',
      },
    ],
    [
      'origines locales',
      {
        PUBLIC_APP_URL: 'http://127.0.0.1:3200',
        CORS_ORIGIN: 'http://127.0.0.1:3200,http://localhost:3200',
      },
    ],
    ['origines absentes', {}],
  ])('simulation TOUJOURS refusée en production : %s', (_label, origins) => {
    const env = {
      NODE_ENV: 'production',
      TURNSTILE_SIMULATED: 'true',
      ...(origins as Record<string, string>),
    };
    expect(isSimulationAllowed(env)).toBe(false);
    expect(() => resolveTurnstileConfig(env)).toThrow(
      'TURNSTILE_SIMULATED refusé en production.',
    );
  });

  it('simulation hors production : en test, ou si TOUTES les origines sont en boucle locale', () => {
    expect(isSimulationAllowed({ NODE_ENV: 'test' })).toBe(true);
    expect(
      isSimulationAllowed({
        NODE_ENV: 'development',
        PUBLIC_APP_URL: 'http://127.0.0.1:3200',
        CORS_ORIGIN: 'http://127.0.0.1:3200,http://localhost:3200',
      }),
    ).toBe(true);
    expect(
      isSimulationAllowed({
        NODE_ENV: 'development',
        PUBLIC_APP_URL: 'http://127.0.0.1:3200',
        CORS_ORIGIN: 'http://127.0.0.1:3200,https://www.stock-master.app',
      }),
    ).toBe(false);
    expect(isSimulationAllowed({})).toBe(false);
    expect(
      resolveTurnstileConfig({ NODE_ENV: 'test', TURNSTILE_SIMULATED: 'true' }),
    ).toEqual({ mode: 'simulated' });
  });

  it('clés de test Cloudflare : admises hors production seulement (local)', () => {
    expect(
      resolveTurnstileConfig({
        NODE_ENV: 'development',
        TURNSTILE_SECRET_KEY: TEST_SECRET,
        TURNSTILE_ALLOWED_HOSTNAMES: 'localhost',
      }),
    ).toMatchObject({ mode: 'cloudflare', testKeys: true });
  });
});
