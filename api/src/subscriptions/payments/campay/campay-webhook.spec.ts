import 'reflect-metadata';
import { createHmac } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { SubscriptionsModule } from '../../subscriptions.module';
import { SubscriptionPaymentsService } from '../subscription-payments.service';
import {
  CAMPAY_WEBHOOK_CLOCK_SKEW_SECONDS,
  CAMPAY_WEBHOOK_SIGNATURE_MAX_LENGTH,
  matchSignedNotificationFields,
  verifyCamPayWebhookSignature,
} from './campay-webhook-signature';
import {
  CAMPAY_WEBHOOK_MAX_BODY_BYTES,
  CAMPAY_WEBHOOK_MAX_KEYS,
  CAMPAY_WEBHOOK_MAX_URL_LENGTH,
  CAMPAY_WEBHOOK_MAX_VALUE_LENGTH,
  CamPayWebhookRequest,
  parseCamPayWebhookRequest,
  topLevelJsonKeys,
} from './campay-webhook-payload';
import {
  CAMPAY_WEBHOOK_CONFIG,
  CamPayWebhookConfigError,
  DISABLED_CAMPAY_WEBHOOK,
  assertUsableWebhookKey,
} from './campay-webhook.config';
import { CamPayWebhookService } from './campay-webhook.service';
import { CAMPAY_PROVIDER_NAME } from './campay-provider-name';

/**
 * 1-14D.2F — Webhook CamPay : briques indépendantes.
 *
 * « Contrat CamPay » : comportements tirés de la documentation officielle
 * (paramètre `signature` = JWT HS256 vérifié avec la clé webhook de
 * l'application ; GET en query ou POST JSON ; noms de champs).
 * « Choix internes » : bornes, refus de l'ambiguïté, tolérance d'horloge,
 * réponses — décisions locales, non garanties par CamPay.
 * Clés et jetons FICTIFS ; aucun appel réseau.
 */

const WEBHOOK_KEY = 'fake-campay-webhook-key-14d2f-0001';
const LOGIN_SECRET = 'fake-login-jwt-secret-14d2f-0001';
const NOW_MS = Date.UTC(2026, 9, 3, 12, 0, 0);
const NOW = Math.floor(NOW_MS / 1000);
const REFERENCE = '2ceefe04-1a79-4914-9dd0-c61748c2aecd';
const MERCHANT_REFERENCE = 'SM0123456789ABCDEF01234567';

/** Implémentation INDÉPENDANTE (jsonwebtoken via @nestjs/jwt). */
const signer = new JwtService();
const sign = (
  payload: Record<string, unknown>,
  options: { key?: string; algorithm?: 'HS256' | 'HS384' | 'HS512' } = {},
  header: Record<string, unknown> = { app: 'Test' },
) =>
  signer.sign(payload, {
    secret: options.key ?? WEBHOOK_KEY,
    algorithm: options.algorithm ?? 'HS256',
    header: { alg: options.algorithm ?? 'HS256', typ: 'JWT', ...header },
    // jsonwebtoken supprime `iat` avec noTimestamp : seulement s'il est absent.
    noTimestamp: !('iat' in payload),
  });

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const hmac = (input: string, key = WEBHOOK_KEY) =>
  createHmac('sha256', key).update(input).digest('base64url');
/** Jeton construit à la main (en-têtes inhabituels). */
const handMade = (header: unknown, payload: unknown, key = WEBHOOK_KEY) => {
  const unsigned = `${b64(header)}.${b64(payload)}`;
  return `${unsigned}.${hmac(unsigned, key)}`;
};

const verify = (token: string, now = NOW_MS) =>
  verifyCamPayWebhookSignature(token, WEBHOOK_KEY, now);

/** Forme des claims des exemples officiels (`iat`, `nbf`, `exp`). */
const camPayLikeClaims = () => ({ iat: NOW, nbf: NOW, exp: NOW + 3600 });

describe('Contrat CamPay — signature JWT HS256 avec la clé webhook', () => {
  it('accepte un jeton HS256 signé par une implémentation indépendante, en-têtes officiels compris (`app`, `uid`)', () => {
    for (const header of [{ app: 'Test' }, { uid: 2 }, {}]) {
      const result = verify(sign(camPayLikeClaims(), {}, header));
      expect(result).toEqual({ ok: true, claims: camPayLikeClaims() });
    }
  });

  it('vérification CRYPTOGRAPHIQUE : mauvaise clé, contenu ou en-tête falsifié → refus', () => {
    const token = sign(camPayLikeClaims());
    const [h, p, s] = token.split('.');
    expect(
      verify(sign(camPayLikeClaims(), { key: 'another-fake-key-0000' })),
    ).toEqual({ ok: false, failure: 'signature' });
    expect(
      verify(`${h}.${b64({ ...camPayLikeClaims(), exp: NOW + 99999 })}.${s}`),
    ).toEqual({ ok: false, failure: 'signature' });
    expect(
      verify(`${b64({ alg: 'HS256', typ: 'JWT', app: 'X' })}.${p}.${s}`),
    ).toEqual({ ok: false, failure: 'signature' });
    // Signature tronquée ou d'une autre longueur.
    expect(verify(`${h}.${p}.${s.slice(0, -2)}`).ok).toBe(false);
  });

  it('simple décodage insuffisant : `alg: none` sans signature → refus', () => {
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(camPayLikeClaims())}`;
    expect(verify(`${unsigned}.`)).toEqual({ ok: false, failure: 'malformed' });
    expect(verify(`${unsigned}.${hmac(unsigned)}`)).toEqual({
      ok: false,
      failure: 'algorithm',
    });
  });

  it('algorithme autre que HS256 → refus, même signé avec la bonne clé', () => {
    for (const algorithm of ['HS384', 'HS512'] as const) {
      expect(verify(sign(camPayLikeClaims(), { algorithm }))).toEqual({
        ok: false,
        failure: 'algorithm',
      });
    }
    for (const alg of ['RS256', 'ES256', 'hs256', 'HS256 ']) {
      expect(verify(handMade({ alg, typ: 'JWT' }, camPayLikeClaims()))).toEqual(
        { ok: false, failure: 'algorithm' },
      );
    }
  });

  it('un JWT de CONNEXION (clé JWT_SECRET) est inutilisable comme signature webhook', () => {
    const loginToken = new JwtService({ secret: LOGIN_SECRET }).sign({
      sub: new Types.ObjectId().toHexString(),
      sessionVersion: 0,
    });
    expect(verify(loginToken)).toEqual({ ok: false, failure: 'signature' });
  });
});

describe('Choix internes — forme et contraintes temporelles', () => {
  it('forme compacte stricte : segments, base64url canonique, longueur bornée', () => {
    const token = sign(camPayLikeClaims());
    const [h, p, s] = token.split('.');
    for (const bad of [
      '',
      'abc',
      `${h}.${p}`,
      `${token}.x`,
      `${h}=.${p}.${s}`,
      `${h}.${p}.${s}=`,
      `${h}.${p.replace(/-/g, '+')}+.${s}`,
      `${h} .${p}.${s}`,
      `${h}.${p}.${s}`.padEnd(CAMPAY_WEBHOOK_SIGNATURE_MAX_LENGTH + 1, 'A'),
    ]) {
      expect(verify(bad).ok).toBe(false);
    }
    // Base64url NON canonique : 32 octets = 43 caractères, les 2 bits de
    // poids faible du dernier sont du remplissage. Les basculer donne les
    // MÊMES octets (Buffer les ignore) mais un texte différent → refus.
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const twin = alphabet[alphabet.indexOf(s[s.length - 1]) ^ 1];
    const altered = s.slice(0, -1) + twin;
    expect(Buffer.from(altered, 'base64url')).toEqual(
      Buffer.from(s, 'base64url'),
    );
    expect(verify(`${h}.${p}.${altered}`)).toEqual({
      ok: false,
      failure: 'malformed',
    });
  });

  it('en-tête : `typ` autre que JWT, `crit`, en-tête non objet → refus', () => {
    expect(verify(handMade({ alg: 'HS256', typ: 'JWS' }, {})).ok).toBe(false);
    expect(verify(handMade({ alg: 'HS256', crit: ['exp'] }, {})).ok).toBe(
      false,
    );
    expect(verify(handMade(['HS256'], {})).ok).toBe(false);
  });

  it('contenu non objet ou claims temporels de mauvais type → refus (après signature)', () => {
    expect(verify(handMade({ alg: 'HS256' }, [1, 2]))).toEqual({
      ok: false,
      failure: 'payload',
    });
    for (const claims of [{ exp: '9999999999' }, { nbf: null }, { iat: 'x' }]) {
      expect(verify(handMade({ alg: 'HS256' }, claims))).toEqual({
        ok: false,
        failure: 'payload',
      });
    }
  });

  it('`exp` / `nbf` appliqués SEULEMENT s’ils existent, avec la tolérance locale', () => {
    const skew = CAMPAY_WEBHOOK_CLOCK_SKEW_SECONDS;
    expect(verify(sign({ exp: NOW - skew }))).toEqual({
      ok: false,
      failure: 'expired',
    });
    expect(verify(sign({ exp: NOW - skew + 1 })).ok).toBe(true);
    expect(verify(sign({ nbf: NOW + skew + 1 }))).toEqual({
      ok: false,
      failure: 'not-yet-valid',
    });
    expect(verify(sign({ nbf: NOW + skew })).ok).toBe(true);
    // Aucune durée de vie maximale inventée : sans `exp`, un vieux jeton
    // reste cryptographiquement valide (rejeu possible → simple déclencheur).
    expect(verify(sign({ iat: NOW - 10 * 365 * 86400 })).ok).toBe(true);
    expect(verify(sign({})).ok).toBe(true);
  });
});

describe('Choix internes — concordance claims signés ↔ paramètres reçus', () => {
  it('aucun champ de transaction signé : liste vide (tous les paramètres NON protégés)', () => {
    expect(
      matchSignedNotificationFields(camPayLikeClaims(), {
        reference: REFERENCE,
        status: 'SUCCESSFUL',
      }),
    ).toEqual([]);
  });

  it('champs signés présents : égalité exacte exigée (référence insensible à la casse, nombre ↔ chaîne)', () => {
    const claims = {
      reference: REFERENCE.toUpperCase(),
      amount: 3000,
      status: 'SUCCESSFUL',
      reason: null,
    };
    expect(
      matchSignedNotificationFields(claims, {
        reference: REFERENCE,
        amount: '3000',
        status: 'SUCCESSFUL',
        reason: null,
        currency: 'XAF',
      }),
    ).toEqual(['status', 'reference', 'amount', 'reason']);
    for (const params of [
      {
        reference: REFERENCE,
        amount: '3001',
        status: 'SUCCESSFUL',
        reason: null,
      },
      { reference: REFERENCE, amount: '3000', status: 'FAILED', reason: null },
      { reference: REFERENCE, amount: '3000', reason: null },
      {
        reference: '00000000-1a79-4914-9dd0-c61748c2aecd',
        amount: '3000',
        status: 'SUCCESSFUL',
        reason: null,
      },
    ]) {
      expect(matchSignedNotificationFields(claims, params)).toBeNull();
    }
    expect(
      matchSignedNotificationFields(
        { reference: { a: 1 } },
        { reference: REFERENCE },
      ),
    ).toBeNull();
  });
});

// ─── Paramètres ──────────────────────────────────────────────────────────────

/** Paramètres de l'exemple officiel, référence UUID valide. */
const officialParams = (overrides: Record<string, unknown> = {}) => ({
  status: 'SUCCESSFUL',
  reference: REFERENCE,
  amount: '100',
  currency: 'XAF',
  operator: 'MTN',
  code: 'ABC1234567890',
  operator_reference: '1234567890',
  signature: sign(camPayLikeClaims()),
  endpoint: 'collect',
  external_reference: MERCHANT_REFERENCE,
  external_user: 'xyz',
  extra_first_name: 'xyz',
  extra_last_name: 'xyz',
  extra_email: 'test@zyz.com',
  phone_number: '237123456789',
  redirect_url: 'https://example.com/callback',
  failure_redirect_url: 'https://example.com/callback',
  description: 'test',
  reason: '',
  ...overrides,
});

const get = (
  query: unknown,
  extra: Partial<CamPayWebhookRequest> = {},
): CamPayWebhookRequest => ({
  method: 'GET',
  urlLength: 600,
  query,
  body: undefined,
  rawBody: undefined,
  contentType: undefined,
  ...extra,
});

const post = (
  raw: string,
  extra: Partial<CamPayWebhookRequest> = {},
): CamPayWebhookRequest => {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }
  return {
    method: 'POST',
    urlLength: 30,
    query: {},
    body,
    rawBody: Buffer.from(raw),
    contentType: 'application/json',
    ...extra,
  };
};

/** Query telle que produite par le parseur `simple` d'Express (sans prototype). */
const nullProto = (record: Record<string, unknown>) =>
  Object.assign(Object.create(null) as Record<string, unknown>, record);

describe('Contrat CamPay — GET (query) ou POST (JSON), mêmes champs', () => {
  it('GET : exemple officiel accepté ; référence en minuscules ; indice marchand seulement s’il est bien formé', () => {
    const result = parseCamPayWebhookRequest(
      get(nullProto(officialParams({ reference: REFERENCE.toUpperCase() }))),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notification).toMatchObject({
      reference: REFERENCE,
      endpoint: 'collect',
      merchantReferenceHint: MERCHANT_REFERENCE,
    });
    for (const hint of [
      'asdfasdfasdfadsasdf',
      'SM0123',
      'sm0123456789abcdef01234567',
      'SM0123456789abcdef01234567',
    ]) {
      const other = parseCamPayWebhookRequest(
        get(officialParams({ external_reference: hint })),
      );
      expect(other.ok && other.notification.merchantReferenceHint).toBeNull();
    }
  });

  it('POST JSON : nombres et `null` admis pour les champs non exploités (ex. `amount`, `reason`)', () => {
    const result = parseCamPayWebhookRequest(
      post(JSON.stringify(officialParams({ amount: 100, reason: null }))),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.notification.fields.amount).toBe(100);
  });
});

describe('Choix internes — paramètres ambigus, surdimensionnés ou mal typés', () => {
  it('GET refusé : clé dupliquée (tableau), clé non canonique, objet imbriqué, type inattendu', () => {
    for (const query of [
      officialParams({ reference: [REFERENCE, REFERENCE] }),
      officialParams({ signature: ['a', 'b'] }),
      { ...officialParams(), 'reference[]': REFERENCE },
      { ...officialParams(), Reference: REFERENCE },
      { ...officialParams(), 'a.b': 'x' },
      officialParams({ status: { $ne: 'x' } }),
      officialParams({ amount: 100 }),
      'reference=x',
      null,
    ]) {
      expect(parseCamPayWebhookRequest(get(query))).toEqual({
        ok: false,
        error: 'invalid',
      });
    }
  });

  it('champs exploités obligatoires et bien formés : signature, référence UUID', () => {
    const base = officialParams();
    const { signature: _s, ...withoutSignature } = base;
    const { reference: _r, ...withoutReference } = base;
    void _s;
    void _r;
    for (const query of [
      withoutSignature,
      withoutReference,
      officialParams({ signature: '' }),
      officialParams({ reference: 'xyz' }),
      officialParams({ reference: `${REFERENCE} ` }),
    ]) {
      expect(parseCamPayWebhookRequest(get(query)).ok).toBe(false);
    }
  });

  it('bornes : nombre de clés, longueur des valeurs et de la signature, URL', () => {
    const many: Record<string, string> = { ...officialParams() };
    for (
      let i = 0;
      Object.keys(many).length <= CAMPAY_WEBHOOK_MAX_KEYS;
      i += 1
    ) {
      many[`extra_${String.fromCharCode(97 + (i % 26))}${'x'.repeat(i)}`] = 'v';
    }
    expect(parseCamPayWebhookRequest(get(many)).ok).toBe(false);
    expect(
      parseCamPayWebhookRequest(
        get(
          officialParams({
            description: 'x'.repeat(CAMPAY_WEBHOOK_MAX_VALUE_LENGTH + 1),
          }),
        ),
      ).ok,
    ).toBe(false);
    expect(
      parseCamPayWebhookRequest(
        get(
          officialParams({
            description: 'x'.repeat(CAMPAY_WEBHOOK_MAX_VALUE_LENGTH),
          }),
        ),
      ).ok,
    ).toBe(true);
    expect(
      parseCamPayWebhookRequest(
        get(
          officialParams({
            signature: 'a'.repeat(CAMPAY_WEBHOOK_SIGNATURE_MAX_LENGTH + 1),
          }),
        ),
      ).ok,
    ).toBe(false);
    expect(
      parseCamPayWebhookRequest(
        get(officialParams(), { urlLength: CAMPAY_WEBHOOK_MAX_URL_LENGTH + 1 }),
      ),
    ).toEqual({ ok: false, error: 'too-large' });
  });

  it('deux sources concurrentes refusées : GET avec corps, POST avec query', () => {
    expect(
      parseCamPayWebhookRequest(
        get(officialParams(), { body: { reference: REFERENCE } }),
      ).ok,
    ).toBe(false);
    expect(
      parseCamPayWebhookRequest(
        get(officialParams(), { rawBody: Buffer.from('{}') }),
      ).ok,
    ).toBe(false);
    expect(
      parseCamPayWebhookRequest(
        post(JSON.stringify(officialParams()), {
          query: { reference: REFERENCE },
        }),
      ).ok,
    ).toBe(false);
  });

  it('POST : clé JSON dupliquée détectée sur le corps BRUT (JSON.parse l’écraserait)', () => {
    const params = officialParams();
    const raw = JSON.stringify(params).replace(
      '"reference":',
      `"reference":"00000000-0000-4000-8000-000000000000","reference":`,
    );
    expect(Object.keys(JSON.parse(raw) as object)).toHaveLength(
      Object.keys(params).length,
    );
    expect(parseCamPayWebhookRequest(post(raw))).toEqual({
      ok: false,
      error: 'invalid',
    });
    // Doublon par séquence d'échappement (`reference` = `reference`).
    const escaped = JSON.stringify(params).replace(
      '"status":',
      '"\\u0072eference":"00000000-0000-4000-8000-000000000000","status":',
    );
    expect(parseCamPayWebhookRequest(post(escaped)).ok).toBe(false);
  });

  it('POST refusé : type de contenu, corps brut absent, objet non plat, types inattendus, corps trop gros', () => {
    const raw = JSON.stringify(officialParams());
    expect(
      parseCamPayWebhookRequest(post(raw, { contentType: 'text/plain' })).ok,
    ).toBe(false);
    expect(
      parseCamPayWebhookRequest(
        post(raw, { contentType: 'application/x-www-form-urlencoded' }),
      ).ok,
    ).toBe(false);
    expect(
      parseCamPayWebhookRequest(post(raw, { rawBody: undefined })).ok,
    ).toBe(false);
    for (const body of [
      officialParams({ meta: { a: 1 } }),
      officialParams({ reference: 123 }),
      officialParams({ endpoint: true }),
      officialParams({ external_reference: ['x'] }),
      [officialParams()],
    ]) {
      expect(parseCamPayWebhookRequest(post(JSON.stringify(body))).ok).toBe(
        false,
      );
    }
    expect(parseCamPayWebhookRequest(post('{"reference":'))).toEqual({
      ok: false,
      error: 'invalid',
    });
    const big = JSON.stringify(
      officialParams({
        description: 'x'.repeat(CAMPAY_WEBHOOK_MAX_BODY_BYTES),
      }),
    );
    expect(parseCamPayWebhookRequest(post(big))).toEqual({
      ok: false,
      error: 'too-large',
    });
  });

  it('topLevelJsonKeys : premier niveau seulement, chaînes échappées, structures imbriquées', () => {
    expect(
      topLevelJsonKeys(
        '{"a":"x\\"y,\\"b\\":1","c":{"d":1,"e":[{"f":2}]},"g":null}',
      ),
    ).toEqual(['a', 'c', 'g']);
    expect(topLevelJsonKeys('{"a":1,"a":2}')).toEqual(['a', 'a']);
    expect(topLevelJsonKeys('[1]')).toBeNull();
    expect(topLevelJsonKeys('{')).toBeNull();
  });
});

// ─── Configuration et désactivation ──────────────────────────────────────────

describe('Choix internes — clé webhook distincte, désactivation par défaut', () => {
  it('clé refusée : absente, trop courte, espaces, égale au secret de connexion ; message sans la clé', () => {
    for (const key of [undefined, '', 'short', ` ${WEBHOOK_KEY}`, 42]) {
      expect(() => assertUsableWebhookKey(key, [LOGIN_SECRET])).toThrow(
        CamPayWebhookConfigError,
      );
    }
    expect(() => assertUsableWebhookKey(LOGIN_SECRET, [LOGIN_SECRET])).toThrow(
      'must differ from login JWT secrets',
    );
    try {
      assertUsableWebhookKey(LOGIN_SECRET, [LOGIN_SECRET]);
    } catch (error) {
      expect(String(error)).not.toContain(LOGIN_SECRET);
    }
    expect(() =>
      assertUsableWebhookKey(WEBHOOK_KEY, [LOGIN_SECRET]),
    ).not.toThrow();
  });

  it('`SubscriptionsModule` enregistre la configuration DÉSACTIVÉE', () => {
    const providers = Reflect.getMetadata('providers', SubscriptionsModule) as {
      provide?: unknown;
      useValue?: unknown;
    }[];
    const config = providers.filter(
      (p) => p?.provide === CAMPAY_WEBHOOK_CONFIG,
    );
    expect(config).toHaveLength(1);
    expect(config[0].useValue).toBe(DISABLED_CAMPAY_WEBHOOK);
    expect(DISABLED_CAMPAY_WEBHOOK).toEqual({ enabled: false });
    expect(Object.isFrozen(DISABLED_CAMPAY_WEBHOOK)).toBe(true);
  });

  it('aucune variable d’environnement lue par le webhook (activation par injection seulement)', () => {
    const files = readdirSync(__dirname).filter(
      (n) => n.startsWith('campay-webhook') && !n.endsWith('.spec.ts'),
    );
    for (const name of files) {
      expect(readFileSync(join(__dirname, name), 'utf8')).not.toMatch(
        /process\.env|ConfigService\s*\)\s*\.get\(\s*['"]CAMPAY/,
      );
    }
  });

  /** Faux service de paiement : mocks séparés (aucune méthode détachée). */
  const payments = () => {
    const locate = jest.fn();
    const confirm = jest.fn();
    const service = {
      locateProviderNotification: locate,
      confirmPayment: confirm,
    } as unknown as SubscriptionPaymentsService;
    return { service, locate, confirm };
  };
  const config = (jwtSecret = LOGIN_SECRET) =>
    ({ get: () => jwtSecret }) as unknown as ConfigService;

  it('désactivé : 503 sans lire les paramètres, sans base ni prestataire', async () => {
    const deps = payments();
    const service = new CamPayWebhookService(
      DISABLED_CAMPAY_WEBHOOK,
      deps.service,
      config(),
    );
    expect(service.enabled).toBe(false);
    const getter = jest.fn(() => officialParams());
    const request = Object.defineProperty(get(undefined), 'query', {
      get: getter,
    });
    const response = await service.handle(request);
    expect(response).toEqual({
      status: 503,
      body: {
        statusCode: 503,
        code: 'PAYMENT_WEBHOOK_DISABLED',
        message: 'Notifications de paiement désactivées.',
      },
    });
    expect(getter).not.toHaveBeenCalled();
    expect(deps.locate).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it('activation refusée si la clé webhook égale JWT_SECRET', () => {
    expect(
      () =>
        new CamPayWebhookService(
          { enabled: true, webhookKey: LOGIN_SECRET },
          payments().service,
          config(LOGIN_SECRET),
        ),
    ).toThrow(CamPayWebhookConfigError);
  });

  it('activé (injection) : signature vérifiée AVANT la base ; référence CamPay du fournisseur `campay`', async () => {
    const deps = payments();
    deps.locate.mockResolvedValue({ kind: 'unknown' });
    const service = new CamPayWebhookService(
      { enabled: true, webhookKey: WEBHOOK_KEY, now: () => NOW_MS },
      deps.service,
      config(),
    );
    const forged = handMade({ alg: 'HS256' }, {}, 'wrong-key-wrong-key-00');
    expect(
      (await service.handle(get(officialParams({ signature: forged })))).status,
    ).toBe(401);
    expect(deps.locate).not.toHaveBeenCalled();

    expect((await service.handle(get(officialParams()))).status).toBe(200);
    expect(deps.locate).toHaveBeenCalledWith(
      CAMPAY_PROVIDER_NAME,
      REFERENCE,
      MERCHANT_REFERENCE,
    );
    expect(deps.confirm).not.toHaveBeenCalled();
  });
});
