import 'reflect-metadata';
import { readdirSync, readFileSync } from 'fs';
import { createServer, Server } from 'http';
import { join } from 'path';
import { SubscriptionsModule } from '../../subscriptions.module';
import { AddressInfo } from 'net';
import {
  PAYMENT_PROVIDER,
  PaymentCollectionRequest,
  PaymentProviderUncertainError,
  PaymentProviderUnavailableError,
  UnavailablePaymentProvider,
} from '../payment-provider';
import {
  CAMPAY_CALL_BUDGET_MS,
  CAMPAY_TOKEN_SAFETY_MARGIN_MS,
  CamPayPaymentProvider,
  CamPayStatusUnavailableError,
  mapCamPayStatusText,
  parseCamPayAmount,
  parseCamPayJson,
} from './campay-payment-provider';
import {
  CamPayHttpRequest,
  CamPayHttpResponse,
  CamPayTransportError,
  classifyFetchFailure,
  fetchCamPayTransport,
} from './campay-transport';

/**
 * 1-14D.2D — Adaptateur CamPay avec un FAUX transport (aucun réseau, aucun
 * domaine CamPay). Identifiants et références fictifs.
 */

const USERNAME = 'fake-app-username-14d2d';
const PASSWORD = 'fake-app-password-14d2d';
const TOKEN = 'fake.jwt.token-14d2d';
const CAMPAY_REF = 'BCEDDE9B-62A7-4421-96AC-2E6179552A1A';
const CAMPAY_REF_LC = CAMPAY_REF.toLowerCase();
const MERCHANT_REF = 'SM64B7F0A1C2D3E4F5A6B7C8D9';
const PHONE = '237677123456';

const collectRequest = (
  overrides: Partial<PaymentCollectionRequest> = {},
): PaymentCollectionRequest => ({
  merchantReference: MERCHANT_REF,
  amount: 3000,
  currency: 'XAF',
  payerPhone: PHONE,
  description: 'Abonnement Stock Master (1 mois)',
  ...overrides,
});

const json = (status: number, body: unknown): CamPayHttpResponse => ({
  status,
  bodyText: typeof body === 'string' ? body : JSON.stringify(body),
});

const tokenOk = (expiresIn: unknown = 3600) =>
  json(200, { token: TOKEN, expires_in: expiresIn });

type Handler = (request: CamPayHttpRequest) => Promise<CamPayHttpResponse>;

/** Faux transport : réponses par chemin, appels enregistrés. */
function fakeTransport(routes: Record<string, Handler | Handler[]>) {
  const calls: CamPayHttpRequest[] = [];
  const transport = async (request: CamPayHttpRequest) => {
    calls.push(request);
    const path = new URL(request.url).pathname;
    const key = Object.keys(routes).find((k) =>
      k.endsWith('*') ? path.startsWith(k.slice(0, -1)) : k === path,
    );
    if (!key) throw new Error(`route inattendue ${path}`);
    const route = routes[key];
    const handler = Array.isArray(route) ? route.shift() : route;
    if (!handler) throw new Error(`plus de réponse pour ${path}`);
    return handler(request);
  };
  return { transport, calls };
}

const fixed =
  (response: CamPayHttpResponse): Handler =>
  () =>
    Promise.resolve(response);

function clock(start = 1_000) {
  let now = start;
  return {
    read: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function provider(
  routes: Record<string, Handler | Handler[]>,
  monotonic = clock(),
) {
  const fake = fakeTransport(routes);
  const instance = new CamPayPaymentProvider({
    environment: 'production',
    username: USERNAME,
    password: PASSWORD,
    transport: fake.transport,
    monotonic: monotonic.read,
  });
  return { instance, calls: fake.calls, monotonic };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

const consoleSpies: jest.SpyInstance[] = [];
beforeEach(() => {
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    consoleSpies.push(jest.spyOn(console, method).mockImplementation());
  }
});
afterEach(() => {
  // Aucune donnée journalisée par l'adaptateur, quel que soit le scénario.
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  consoleSpies.splice(0).forEach((spy) => spy.mockRestore());
  jest.useRealTimers();
});

describe('CamPayPaymentProvider — construction (1-14D.2D)', () => {
  it('aucun appel réseau à la construction ; capacités non confirmées désactivées', () => {
    const { instance, calls } = provider({});
    expect(calls).toHaveLength(0);
    expect(instance.name).toBe('campay');
    expect(instance.available).toBe(true);
    expect(instance.supportsMerchantReferenceLookup).toBe(false);
    expect(instance.idempotentInitiation).toBe(false);
  });

  it.each([
    [{ environment: 'staging', username: 'u', password: 'p' }],
    [{ environment: 'production', username: '', password: 'p' }],
    [{ environment: 'production', username: 'u', password: '' }],
    [{ environment: 'production' }],
    [{ environment: '__proto__', username: 'u', password: 'p' }],
  ])(
    'configuration invalide %p → refusée (aucune valeur par défaut)',
    (config) => {
      expect(
        () =>
          new CamPayPaymentProvider(
            config as unknown as ConstructorParameters<
              typeof CamPayPaymentProvider
            >[0],
          ),
      ).toThrow();
    },
  );

  it('identifiants invisibles à la sérialisation et à l’inspection', () => {
    const { instance } = provider({});
    const dump = JSON.stringify(instance) + Object.keys(instance).join(',');
    expect(dump).not.toContain(USERNAME);
    expect(dump).not.toContain(PASSWORD);
  });

  it('origine HTTPS officielle selon l’environnement, jamais fournie par un client', async () => {
    for (const [environment, origin] of [
      ['demo', 'https://demo.campay.net'],
      ['production', 'https://www.campay.net'],
    ] as const) {
      const fake = fakeTransport({
        '/api/token/': fixed(tokenOk()),
        '/api/collect/': fixed(json(200, { reference: CAMPAY_REF })),
      });
      await new CamPayPaymentProvider({
        environment,
        username: USERNAME,
        password: PASSWORD,
        transport: fake.transport,
      }).initiate(collectRequest());
      expect(fake.calls.every((c) => c.url.startsWith(`${origin}/api/`))).toBe(
        true,
      );
    }
  });
});

describe('Authentification', () => {
  it('payload exact du jeton puis en-tête `Token`', async () => {
    const { instance, calls } = provider({
      '/api/token/': fixed(tokenOk()),
      '/api/collect/': fixed(json(200, { reference: CAMPAY_REF })),
    });
    await instance.initiate(collectRequest());
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://www.campay.net/api/token/',
    });
    expect(JSON.parse(calls[0].body!)).toEqual({
      username: USERNAME,
      password: PASSWORD,
    });
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(calls[1].headers.Authorization).toBe(`Token ${TOKEN}`);
  });

  it('jeton réutilisé jusqu’à `expires_in` − marge, puis renouvelé', async () => {
    const time = clock();
    const { instance, calls } = provider(
      {
        '/api/token/': [fixed(tokenOk(3600)), fixed(tokenOk(3600))],
        '/api/transaction/*': fixed(
          json(200, { reference: CAMPAY_REF, status: 'PENDING' }),
        ),
      },
      time,
    );
    const lookup = { by: 'provider', providerReference: CAMPAY_REF } as const;
    await instance.fetchStatus(lookup);
    time.advance(3600_000 - CAMPAY_TOKEN_SAFETY_MARGIN_MS - 1);
    await instance.fetchStatus(lookup);
    expect(calls.filter((c) => c.url.endsWith('/api/token/'))).toHaveLength(1);
    time.advance(1);
    await instance.fetchStatus(lookup);
    expect(calls.filter((c) => c.url.endsWith('/api/token/'))).toHaveLength(2);
  });

  it.each([undefined, 'x', 30, -1, 1.5])(
    '`expires_in` %p absent, invalide ou trop court → jeton non conservé',
    async (expiresIn) => {
      const { instance, calls } = provider({
        '/api/token/': [1, 2].map(() =>
          // `undefined` : champ ABSENT (pas la valeur par défaut du helper).
          fixed(
            json(200, {
              token: TOKEN,
              ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
            }),
          ),
        ),
        '/api/transaction/*': fixed(
          json(200, { reference: CAMPAY_REF, status: 'PENDING' }),
        ),
      });
      const lookup = { by: 'provider', providerReference: CAMPAY_REF } as const;
      await instance.fetchStatus(lookup);
      await instance.fetchStatus(lookup);
      expect(calls.filter((c) => c.url.endsWith('/api/token/'))).toHaveLength(
        2,
      );
    },
  );
});

describe('Initiation', () => {
  it('payload exact (montant entier en chaîne, référence marchand persistée) → `accepted`, jamais un succès', async () => {
    const { instance, calls } = provider({
      '/api/token/': fixed(tokenOk()),
      '/api/collect/': fixed(
        json(200, {
          reference: CAMPAY_REF,
          ussd_code: '*126#',
          operator: 'mtn',
        }),
      ),
    });
    const result = await instance.initiate(collectRequest());
    expect(result).toEqual({
      outcome: 'accepted',
      providerReference: CAMPAY_REF_LC,
    });
    const collect = calls[1];
    expect(collect.method).toBe('POST');
    expect(collect.url).toBe('https://www.campay.net/api/collect/');
    expect(collect.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(collect.body!)).toEqual({
      amount: '3000',
      currency: 'XAF',
      from: PHONE,
      description: 'Abonnement Stock Master (1 mois)',
      external_reference: MERCHANT_REF,
    });
    // Aucune consultation de statut (pas de sondage façon SDK `collect`).
    expect(calls.some((c) => c.url.includes('/api/transaction/'))).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['montant décimal', { amount: 3000.5 }],
    ['montant nul', { amount: 0 }],
    ['montant hors plage sûre', { amount: Number.MAX_SAFE_INTEGER + 1 }],
    ['devise', { currency: 'XOF' as 'XAF' }],
    ['téléphone non normalisé', { payerPhone: '677123456' }],
    ['référence marchand vide', { merchantReference: '' }],
  ])('%s → indisponible, aucun appel', async (_label, overrides) => {
    const { instance, calls } = provider({});
    await expect(
      instance.initiate(collectRequest(overrides)),
    ).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['jeton refusé (401)', fixed(json(401, { detail: 'x' }))],
    ['jeton 500', fixed(json(500, 'oops'))],
    ['jeton illisible', fixed(json(200, 'not json'))],
    ['jeton absent', fixed(json(200, { expires_in: 3600 }))],
    [
      'transport du jeton en échec',
      () => Promise.reject(new CamPayTransportError('unknown')),
    ],
  ])(
    'authentification impossible (%s) → indisponible ; collecte JAMAIS envoyée',
    async (_label, tokenHandler) => {
      const { instance, calls } = provider({
        '/api/token/': tokenHandler,
        '/api/collect/': fixed(json(200, { reference: CAMPAY_REF })),
      });
      await expect(instance.initiate(collectRequest())).rejects.toBeInstanceOf(
        PaymentProviderUnavailableError,
      );
      expect(calls.some((c) => c.url.endsWith('/api/collect/'))).toBe(false);
    },
  );

  it('collecte certainement non envoyée (connexion impossible) → indisponible', async () => {
    const { instance } = provider({
      '/api/token/': fixed(tokenOk()),
      '/api/collect/': () =>
        Promise.reject(new CamPayTransportError('not-sent')),
    });
    await expect(instance.initiate(collectRequest())).rejects.toBeInstanceOf(
      PaymentProviderUnavailableError,
    );
  });

  it.each([
    [
      'réponse perdue après envoi',
      () => Promise.reject(new CamPayTransportError('unknown')),
    ],
    ['erreur quelconque du transport', () => Promise.reject(new Error('x'))],
    ['500', fixed(json(500, 'oops'))],
    ['502', fixed(json(502, '<html>gateway</html>'))],
    // Codes officiels sans structure d'erreur documentée : jamais définitif.
    ['400 ER101', fixed(json(400, { message: 'ER101 Invalid phone number' }))],
    ['400 ER102', fixed(json(400, { message: 'ER102', error_code: 'ER102' }))],
    ['200 illisible', fixed(json(200, 'not json'))],
    ['200 sans référence', fixed(json(200, { ussd_code: '*126#' }))],
    ['200 référence non UUID', fixed(json(200, { reference: '../../x' }))],
  ])(
    '%s → INCERTAIN (la collecte existe peut-être)',
    async (_label, handler) => {
      const { instance, calls } = provider({
        '/api/token/': fixed(tokenOk()),
        '/api/collect/': handler,
      });
      const error = await errorOf(instance.initiate(collectRequest()));
      expect(error).toBeInstanceOf(PaymentProviderUncertainError);
      // Aucune seconde collecte.
      expect(calls.filter((c) => c.url.endsWith('/api/collect/'))).toHaveLength(
        1,
      );
    },
  );

  it('401 sur la collecte → incertain ; jeton oublié, aucune relance de collecte', async () => {
    const { instance, calls } = provider({
      '/api/token/': [fixed(tokenOk()), fixed(tokenOk())],
      '/api/collect/': fixed(json(401, { detail: 'expired' })),
      '/api/transaction/*': fixed(
        json(200, { reference: CAMPAY_REF, status: 'PENDING' }),
      ),
    });
    await expect(instance.initiate(collectRequest())).rejects.toBeInstanceOf(
      PaymentProviderUncertainError,
    );
    expect(calls.filter((c) => c.url.endsWith('/api/collect/'))).toHaveLength(
      1,
    );
    await instance.fetchStatus({
      by: 'provider',
      providerReference: CAMPAY_REF,
    });
    expect(calls.filter((c) => c.url.endsWith('/api/token/'))).toHaveLength(2);
  });
});

describe('Budget de 10 s (échéance unique, annulation effective)', () => {
  it('l’authentification consomme le budget ; la collecte reçoit le RESTE puis est annulée → incertain', async () => {
    jest.useFakeTimers();
    const time = clock();
    let collectSignal: AbortSignal | undefined;
    const { instance } = provider(
      {
        '/api/token/': () => {
          time.advance(4_000);
          return Promise.resolve(tokenOk());
        },
        '/api/collect/': (request) =>
          new Promise((_resolve, reject) => {
            collectSignal = request.signal;
            request.signal.addEventListener('abort', () =>
              reject(new CamPayTransportError('unknown')),
            );
          }),
      },
      time,
    );
    const pending = errorOf(instance.initiate(collectRequest()));
    await jest.advanceTimersByTimeAsync(5_999);
    expect(collectSignal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(collectSignal?.aborted).toBe(true);
    expect(await pending).toBeInstanceOf(PaymentProviderUncertainError);
  });

  it('budget épuisé par l’authentification → collecte JAMAIS envoyée → indisponible', async () => {
    const time = clock();
    const { instance, calls } = provider(
      {
        '/api/token/': () => {
          time.advance(CAMPAY_CALL_BUDGET_MS);
          return Promise.resolve(tokenOk());
        },
        '/api/collect/': fixed(json(200, { reference: CAMPAY_REF })),
      },
      time,
    );
    await expect(instance.initiate(collectRequest())).rejects.toBeInstanceOf(
      PaymentProviderUnavailableError,
    );
    expect(calls.some((c) => c.url.endsWith('/api/collect/'))).toBe(false);
  });

  it('jeton bloqué : annulé à 10 s → indisponible', async () => {
    jest.useFakeTimers();
    let tokenSignal: AbortSignal | undefined;
    const { instance } = provider({
      '/api/token/': (request) =>
        new Promise((_resolve, reject) => {
          tokenSignal = request.signal;
          request.signal.addEventListener('abort', () =>
            reject(new CamPayTransportError('unknown')),
          );
        }),
    });
    const pending = errorOf(instance.initiate(collectRequest()));
    await jest.advanceTimersByTimeAsync(CAMPAY_CALL_BUDGET_MS - 1);
    expect(tokenSignal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(tokenSignal?.aborted).toBe(true);
    expect(await pending).toBeInstanceOf(PaymentProviderUnavailableError);
  });

  it('consultation : budget partagé avec l’authentification, annulée à l’échéance', async () => {
    jest.useFakeTimers();
    const time = clock();
    let statusSignal: AbortSignal | undefined;
    const { instance } = provider(
      {
        '/api/token/': () => {
          time.advance(9_000);
          return Promise.resolve(tokenOk());
        },
        '/api/transaction/*': (request) =>
          new Promise((_resolve, reject) => {
            statusSignal = request.signal;
            request.signal.addEventListener('abort', () =>
              reject(new CamPayTransportError('unknown')),
            );
          }),
      },
      time,
    );
    const pending = errorOf(
      instance.fetchStatus({ by: 'provider', providerReference: CAMPAY_REF }),
    );
    await jest.advanceTimersByTimeAsync(999);
    expect(statusSignal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(statusSignal?.aborted).toBe(true);
    expect(await pending).toBeInstanceOf(CamPayStatusUnavailableError);
  });
});

describe('Consultation du statut', () => {
  const status = (body: unknown, code = 200) =>
    provider({
      '/api/token/': fixed(tokenOk()),
      '/api/transaction/*': fixed(json(code, body)),
    });

  it('recherche par référence marchand NON supportée : aucun appel, jamais notre référence chez CamPay', async () => {
    const { instance, calls } = status({});
    const error = await errorOf(
      instance.fetchStatus({ by: 'merchant', merchantReference: MERCHANT_REF }),
    );
    expect(error).toBeInstanceOf(CamPayStatusUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it('référence CamPay invalide (injection de chemin) → aucun appel', async () => {
    const { instance, calls } = status({});
    for (const providerReference of ['../token', MERCHANT_REF, '']) {
      await expect(
        instance.fetchStatus({ by: 'provider', providerReference }),
      ).rejects.toBeInstanceOf(CamPayStatusUnavailableError);
    }
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['PENDING', 'pending'],
    ['SUCCESSFUL', 'succeeded'],
    ['FAILED', 'failed'],
  ])(
    'statut officiel %s → %s, valeurs REÇUES (exemple du contrat)',
    async (official, internal) => {
      const { instance, calls } = status({
        reference: CAMPAY_REF,
        external_reference: MERCHANT_REF,
        status: official,
        amount: 3000.0,
        currency: 'XAF',
        operator: 'MTN',
        code: 'D201102W0002LK',
        operator_reference: null,
        description: 'Test',
        external_user: '',
        reason: null,
        phone_number: '2376xxxxxxxx',
        endpoint: 'collect',
      });
      const result = await instance.fetchStatus({
        by: 'provider',
        providerReference: CAMPAY_REF,
      });
      expect(result).toEqual({
        state: internal,
        providerReference: CAMPAY_REF_LC,
        merchantReference: MERCHANT_REF,
        amount: 3000,
        currency: 'XAF',
      });
      expect(calls[1]).toMatchObject({
        method: 'GET',
        url: `https://www.campay.net/api/transaction/${CAMPAY_REF_LC}/`,
      });
      expect(calls[1].headers.Authorization).toBe(`Token ${TOKEN}`);
    },
  );

  it('champs absents : jamais remplacés par des valeurs locales', () => {
    expect(
      mapCamPayStatusText(
        JSON.stringify({ reference: CAMPAY_REF, status: 'SUCCESSFUL' }),
      ),
    ).toEqual({
      state: 'succeeded',
      providerReference: CAMPAY_REF_LC,
      merchantReference: null,
      amount: null,
      currency: null,
    });
    expect(
      mapCamPayStatusText(
        JSON.stringify({
          reference: CAMPAY_REF,
          status: 'PENDING',
          external_reference: '',
          currency: 12,
        }),
      ),
    ).toMatchObject({ merchantReference: null, currency: null });
  });

  it.each([
    ['statut inconnu', { reference: CAMPAY_REF, status: 'REVERSED' }],
    ['statut en minuscules', { reference: CAMPAY_REF, status: 'successful' }],
    ['clé héritée', { reference: CAMPAY_REF, status: 'toString' }],
    ['statut absent', { reference: CAMPAY_REF }],
    ['référence absente', { status: 'SUCCESSFUL' }],
    ['référence invalide', { reference: 'x', status: 'SUCCESSFUL' }],
    ['corps tableau', [{ reference: CAMPAY_REF, status: 'SUCCESSFUL' }]],
    ['corps non JSON', 'not json'],
  ])('%s → statut indisponible (aucune activation)', async (_label, body) => {
    const { instance } = status(body);
    await expect(
      instance.fetchStatus({ by: 'provider', providerReference: CAMPAY_REF }),
    ).rejects.toBeInstanceOf(CamPayStatusUnavailableError);
  });

  it.each([404, 401, 500, 503])(
    'HTTP %i → statut indisponible',
    async (code) => {
      const { instance } = status({ detail: 'x' }, code);
      await expect(
        instance.fetchStatus({ by: 'provider', providerReference: CAMPAY_REF }),
      ).rejects.toBeInstanceOf(CamPayStatusUnavailableError);
    },
  );

  /** Corps de statut BRUT : le montant est inséré tel quel dans le texte. */
  const rawStatus = (amountLiteral: string) =>
    `{"reference":"${CAMPAY_REF}","external_reference":"${MERCHANT_REF}",` +
    `"status":"SUCCESSFUL","amount":${amountLiteral},"currency":"XAF"}`;

  it.each([
    // Entiers exacts (dont `3000.0`, forme de l'exemple officiel `2.0`).
    ['3000', 3000],
    ['3000.0', 3000],
    ['3000.00', 3000],
    ['2.0', 2],
    ['0', 0],
    ['0.0', 0],
    ['"3000"', 3000],
    // Littéraux NON entiers que `JSON.parse` arrondirait à un entier.
    ['3000.0000000000000001', null],
    ['2999.9999999999999999', null],
    ['3000.5', null],
    ['3000.0001', null],
    ['3e3', null],
    ['3E3', null],
    ['3000e0', null],
    ['30000e-1', null],
    ['-0', null],
    ['-3000', null],
    ['9007199254740993', null],
    ['9007199254740992', null],
    ['1e21', null],
    ['"3000.0"', null],
    ['"03000"', null],
    ['" 3000"', null],
    ['"-1"', null],
    ['"9007199254740993"', null],
    ['null', null],
    ['{}', null],
    ['[3000]', null],
    ['true', null],
  ])(
    'montant BRUT %s → %p (représentation d’origine validée avant conversion)',
    (literal, expected) => {
      expect(mapCamPayStatusText(rawStatus(literal)).amount).toBe(expected);
    },
  );

  it('montant absent → null (jamais la valeur locale)', () => {
    expect(
      mapCamPayStatusText(
        `{"reference":"${CAMPAY_REF}","status":"SUCCESSFUL","currency":"XAF"}`,
      ).amount,
    ).toBeNull();
  });

  it('nombre SANS représentation d’origine → null (échec fermé)', () => {
    expect(parseCamPayAmount(3000)).toBeNull();
    expect(parseCamPayAmount(3000, '3000')).toBe(3000);
    // Source et valeur incohérentes : refus.
    expect(parseCamPayAmount(3001, '3000')).toBeNull();
  });

  it('runtime : le texte source JSON est disponible (sinon échec fermé)', () => {
    const parsed = parseCamPayJson('{"amount":3000.0000000000000001}');
    expect(parsed?.amountSource).toBe('3000.0000000000000001');
    expect((parsed?.body as { amount: number }).amount).toBe(3000);
  });

  it('seul le `amount` de PREMIER niveau est pris en compte', () => {
    const parsed = parseCamPayJson(
      '{"nested":{"amount":3000},"amount":2999.9999999999999999}',
    );
    expect(parsed?.amountSource).toBe('2999.9999999999999999');
    expect(
      parseCamPayJson('{"nested":{"amount":3000}}')?.amountSource,
    ).toBeUndefined();
  });

  it('clé `amount` dupliquée : la DERNIÈRE valeur et sa source', () => {
    const text = rawStatus('3000').replace(
      '"amount":3000',
      '"amount":3000,"amount":2999.9999999999999999',
    );
    expect(mapCamPayStatusText(text).amount).toBeNull();
  });
});

describe('Aucune donnée sensible dans les erreurs', () => {
  it('messages génériques : ni identifiants, ni jeton, ni téléphone, ni corps', async () => {
    const secretBody = `{"message":"${PASSWORD} ${TOKEN} ${PHONE}"}`;
    const errors: unknown[] = [];
    const scenarios: Array<Record<string, Handler>> = [
      { '/api/token/': fixed({ status: 401, bodyText: secretBody }) },
      {
        '/api/token/': fixed(tokenOk()),
        '/api/collect/': fixed({ status: 400, bodyText: secretBody }),
      },
      {
        '/api/token/': fixed(tokenOk()),
        '/api/collect/': () =>
          Promise.reject(new Error(`${PASSWORD} ${TOKEN} ${PHONE}`)),
      },
    ];
    for (const routes of scenarios) {
      errors.push(
        await errorOf(provider(routes).instance.initiate(collectRequest())),
      );
    }
    errors.push(
      await errorOf(
        provider({
          '/api/token/': fixed(tokenOk()),
          '/api/transaction/*': fixed({ status: 500, bodyText: secretBody }),
        }).instance.fetchStatus({
          by: 'provider',
          providerReference: CAMPAY_REF,
        }),
      ),
    );
    for (const error of errors) {
      const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ''}`;
      for (const secret of [USERNAME, PASSWORD, TOKEN, PHONE]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});

describe('Transport `fetch` de production (serveur LOCAL, aucun domaine CamPay)', () => {
  let server: Server;
  let base = '';
  let hits = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits += 1;
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' });
        res.end();
      } else if (req.url === '/hang') {
        // Ne répond jamais : seule l'annulation libère la requête.
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const request = (path: string, signal = new AbortController().signal) =>
    fetchCamPayTransport({
      method: 'GET',
      url: `${base}${path}`,
      headers: { Authorization: 'Token secret-header' },
      signal,
    });

  it('réponse normale', async () => {
    await expect(request('/ok')).resolves.toEqual({
      status: 200,
      bodyText: '{"ok":true}',
    });
  });

  it('redirection REFUSÉE (identifiants jamais renvoyés ailleurs) → issue inconnue', async () => {
    const before = hits;
    const error = await errorOf(request('/redirect'));
    expect(error).toBeInstanceOf(CamPayTransportError);
    expect((error as CamPayTransportError).failure).toBe('unknown');
    expect(hits).toBe(before + 1);
  });

  it('annulation EFFECTIVE d’une requête en cours → issue inconnue', async () => {
    const controller = new AbortController();
    const pending = errorOf(request('/hang', controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(CamPayTransportError);
    expect((error as CamPayTransportError).failure).toBe('unknown');
  });

  it('connexion refusée → certainement non envoyée', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, '127.0.0.1', resolve),
    );
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const error = await errorOf(
      fetchCamPayTransport({
        method: 'GET',
        url: `http://127.0.0.1:${port}/x`,
        headers: {},
        signal: new AbortController().signal,
      }),
    );
    expect((error as CamPayTransportError).failure).toBe('not-sent');
  });

  it('classification : seuls les échecs de connexion sont « non envoyés »', () => {
    const withCause = (code: string) =>
      Object.assign(new TypeError('fetch failed'), { cause: { code } });
    for (const code of [
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'UND_ERR_CONNECT_TIMEOUT',
    ]) {
      expect(classifyFetchFailure(withCause(code))).toBe('not-sent');
    }
    for (const code of [
      'ECONNRESET',
      'UND_ERR_SOCKET',
      'UND_ERR_HEADERS_TIMEOUT',
    ]) {
      expect(classifyFetchFailure(withCause(code))).toBe('unknown');
    }
    expect(
      classifyFetchFailure(new DOMException('aborted', 'AbortError')),
    ).toBe('unknown');
    expect(classifyFetchFailure(new TypeError('redirect'))).toBe('unknown');
  });
});

describe('Fournisseur de production inchangé (aucune activation de CamPay)', () => {
  it('`SubscriptionsModule` injecte toujours `UnavailablePaymentProvider`', () => {
    const providers = Reflect.getMetadata(
      'providers',
      SubscriptionsModule,
    ) as unknown[];
    const payment = providers.filter(
      (p): p is { provide: unknown; useClass?: unknown } =>
        typeof p === 'object' &&
        p !== null &&
        (p as { provide?: unknown }).provide === PAYMENT_PROVIDER,
    );
    expect(payment).toHaveLength(1);
    expect(payment[0].useClass).toBe(UnavailablePaymentProvider);
    expect(providers).not.toContain(CamPayPaymentProvider);
  });

  // 1-14D.2F : le webhook (`campay-webhook*`, inactif) est enregistré par
  // `SubscriptionsModule` ; le garde-fou vise donc précisément l'ADAPTATEUR
  // et son TRANSPORT, jamais importés hors de `campay/` ni par le webhook.
  const ADAPTER_IMPORT =
    /(from\s+|require\(\s*)['"][^'"]*campay-(payment-provider|transport)['"]/i;

  it('le webhook (1-14D.2F) n’importe ni l’adaptateur ni son transport', () => {
    const webhookFiles = readdirSync(__dirname).filter(
      (name) =>
        name.startsWith('campay-webhook') &&
        name.endsWith('.ts') &&
        !name.endsWith('.spec.ts'),
    );
    expect(webhookFiles.length).toBeGreaterThanOrEqual(5);
    for (const name of webhookFiles) {
      const source = readFileSync(join(__dirname, name), 'utf8');
      expect(ADAPTER_IMPORT.test(source)).toBe(false);
    }
  });

  it('aucun fichier de production hors `campay/` n’importe l’adaptateur ni son transport', () => {
    const root = join(__dirname, '..', '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (path !== __dirname) walk(path);
        } else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.spec.ts') &&
          // Import ou `require` (pas une simple mention).
          ADAPTER_IMPORT.test(readFileSync(path, 'utf8'))
        ) {
          offenders.push(path);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('Montants bruts via le transport `fetch` RÉEL et un serveur HTTP LOCAL', () => {
  let server: Server;
  let base = '';
  let statusAmount = '3000';

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/token/') {
        res.end(`{"token":"${TOKEN}","expires_in":3600}`);
      } else {
        // Corps BRUT : le littéral numérique est écrit tel quel.
        res.end(
          `{"reference":"${CAMPAY_REF}","external_reference":"${MERCHANT_REF}",` +
            `"status":"SUCCESSFUL","amount":${statusAmount},"currency":"XAF"}`,
        );
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  /** Adaptateur réel ; seule l'origine officielle est réécrite vers le serveur local. */
  const localProvider = () =>
    new CamPayPaymentProvider({
      environment: 'production',
      username: USERNAME,
      password: PASSWORD,
      transport: (request) =>
        fetchCamPayTransport({
          ...request,
          url: request.url.replace('https://www.campay.net', base),
        }),
    });

  it.each([
    ['3000.0000000000000001', null],
    ['2999.9999999999999999', null],
    ['3000.0', 3000],
    ['3000', 3000],
  ])('corps brut `"amount":%s` → montant %p', async (literal, expected) => {
    statusAmount = literal;
    const status = await localProvider().fetchStatus({
      by: 'provider',
      providerReference: CAMPAY_REF,
    });
    expect(status).toMatchObject({
      state: 'succeeded',
      merchantReference: MERCHANT_REF,
      currency: 'XAF',
      amount: expected,
    });
  });
});
