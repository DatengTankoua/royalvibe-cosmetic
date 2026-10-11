import { createHmac } from 'crypto';
import {
  PaymentProviderUncertainError,
  PaymentProviderUnavailableError,
} from '../payment-provider';
import { PaymentConfigError, resolvePaymentConfig } from './saspay-config';
import {
  SasPayPaymentProvider,
  parseSasPayAmount,
  unwrapSasPayBody,
  validCheckoutUrl,
} from './saspay-payment-provider';
import {
  SasPayHttpRequest,
  SasPayTransport,
  SasPayTransportError,
} from './saspay-transport';
import { verifySasPayWebhookSignature } from './saspay-webhook-signature';

const LIVE = 'sk_live_fake-unit-live-0001';
const TEST = 'sk_test_fake-unit-test-0001';

describe('Configuration SasPay (1-21B)', () => {
  it('défaut : aucune nouvelle tentative, SasPay non configuré', () => {
    expect(resolvePaymentConfig({})).toEqual({ active: 'none', saspay: null });
  });

  it('CamPay ou valeur inconnue jamais activable par variable', () => {
    for (const value of ['campay', 'simulated', 'SASPAY']) {
      expect(() =>
        resolvePaymentConfig({ PAYMENT_PROVIDER_ACTIVE: value }),
      ).toThrow(PaymentConfigError);
    }
  });

  it('préfixe de clé cohérent avec l’environnement ; messages sans valeur', () => {
    expect(
      resolvePaymentConfig({
        SASPAY_ENVIRONMENT: 'live',
        SASPAY_SECRET_KEY: LIVE,
      }).saspay?.environment,
    ).toBe('live');
    for (const [environment, key] of [
      ['live', TEST],
      ['sandbox', LIVE],
      ['live', 'sk_live_court'],
      ['prod', LIVE],
    ]) {
      let error: unknown;
      try {
        resolvePaymentConfig({
          SASPAY_ENVIRONMENT: environment,
          SASPAY_SECRET_KEY: key,
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(PaymentConfigError);
      expect(String((error as Error).message)).not.toContain(key);
    }
  });

  it('actif sans clé, bac à sable actif en production, secret webhook sans clé ou réutilisé → refus', () => {
    expect(() =>
      resolvePaymentConfig({ PAYMENT_PROVIDER_ACTIVE: 'saspay' }),
    ).toThrow(PaymentConfigError);
    expect(() =>
      resolvePaymentConfig({
        PAYMENT_PROVIDER_ACTIVE: 'saspay',
        SASPAY_ENVIRONMENT: 'sandbox',
        SASPAY_SECRET_KEY: TEST,
        NODE_ENV: 'production',
      }),
    ).toThrow(PaymentConfigError);
    expect(() =>
      resolvePaymentConfig({ SASPAY_WEBHOOK_SECRET: 'x'.repeat(32) }),
    ).toThrow(PaymentConfigError);
    expect(() =>
      resolvePaymentConfig({
        SASPAY_ENVIRONMENT: 'live',
        SASPAY_SECRET_KEY: LIVE,
        SASPAY_WEBHOOK_SECRET: LIVE,
      }),
    ).toThrow(PaymentConfigError);
  });

  it('production : bac à sable refusé même avec `none` (aucune confirmation possible) ; LIVE avec `none` admis pour confirmer', () => {
    for (const active of [undefined, 'none', 'saspay']) {
      let error: unknown;
      try {
        resolvePaymentConfig({
          PAYMENT_PROVIDER_ACTIVE: active,
          SASPAY_ENVIRONMENT: 'sandbox',
          SASPAY_SECRET_KEY: TEST,
          SASPAY_WEBHOOK_SECRET: 'whsec-for-unit-tests-0001',
          NODE_ENV: 'production',
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(PaymentConfigError);
      expect(String((error as Error).message)).not.toContain(TEST);
    }
    expect(
      resolvePaymentConfig({
        SASPAY_ENVIRONMENT: 'live',
        SASPAY_SECRET_KEY: LIVE,
        NODE_ENV: 'production',
      }),
    ).toMatchObject({ active: 'none', saspay: { environment: 'live' } });
    // Hors production : bac à sable admis (vérification préalable).
    expect(
      resolvePaymentConfig({
        SASPAY_ENVIRONMENT: 'sandbox',
        SASPAY_SECRET_KEY: TEST,
      }),
    ).toMatchObject({ active: 'none', saspay: { environment: 'sandbox' } });
  });
});

describe('Signature du webhook SasPay (1-21B, contrat officiel)', () => {
  const secret = 'whsec-for-unit-tests-0001';
  const body = Buffer.from('{"event":"transaction.success","data":{"id":"x"}}');
  const sign = (ts: string, raw = body) =>
    createHmac('sha256', secret).update(`${ts}.`).update(raw).digest('hex');
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);

  it('valide sur le corps BRUT ; altéré, mauvais secret, en-têtes mal formés → invalide', () => {
    expect(
      verifySasPayWebhookSignature({
        rawBody: body,
        signature: sign(ts),
        timestamp: ts,
        secret,
        nowMs: now,
      }),
    ).toBe('valid');
    const reserialized = Buffer.from(
      JSON.stringify(JSON.parse(body.toString()), null, 1),
    );
    for (const input of [
      { rawBody: reserialized, signature: sign(ts) },
      { rawBody: body, signature: sign(ts).toUpperCase() },
      { rawBody: body, signature: sign(ts).slice(1) },
      { rawBody: body, signature: undefined },
    ]) {
      expect(
        verifySasPayWebhookSignature({
          ...input,
          timestamp: ts,
          secret,
          nowMs: now,
        }),
      ).toBe('invalid');
    }
    expect(
      verifySasPayWebhookSignature({
        rawBody: body,
        signature: sign(ts),
        timestamp: ts,
        secret: 'other-secret-0000000000',
        nowMs: now,
      }),
    ).toBe('invalid');
  });

  it('tolérance de 300 s, des deux côtés', () => {
    for (const [offset, expected] of [
      [300, 'valid'],
      [-300, 'valid'],
      [301, 'stale'],
      [-301, 'stale'],
    ] as const) {
      const t = String(now / 1000 - offset);
      expect(
        verifySasPayWebhookSignature({
          rawBody: body,
          signature: sign(t),
          timestamp: t,
          secret,
          nowMs: now,
        }),
      ).toBe(expected);
    }
  });
});

describe('Adaptateur SasPay — formats (1-21B)', () => {
  it('montants : décimal exact sans centimes seulement', () => {
    expect(parseSasPayAmount('3000.00')).toBe(3000);
    expect(parseSasPayAmount('3000')).toBe(3000);
    for (const bad of ['3000.50', '-3000', '3e3', '03000', 3000, null, '']) {
      expect(parseSasPayAmount(bad)).toBeNull();
    }
  });

  it('page de paiement : HTTPS et hôte documenté seulement', () => {
    expect(validCheckoutUrl('https://pay.saspay.me/checkout/abc==')).toBe(
      'https://pay.saspay.me/checkout/abc==',
    );
    for (const bad of [
      'http://pay.saspay.me/checkout/x',
      'https://pay.saspay.me.evil.example/x',
      'https://user:pw@pay.saspay.me/x',
      'https://evil.example/checkout/x',
      'javascript:alert(1)',
      '',
    ]) {
      expect(validCheckoutUrl(bad)).toBeNull();
    }
  });

  it('enveloppe documentée ou corps brut ; échec enveloppé → indéfini', () => {
    expect(
      unwrapSasPayBody({ success: true, data: { id: 1 }, code: 200 }),
    ).toEqual({ id: 1 });
    expect(unwrapSasPayBody({ id: 1 })).toEqual({ id: 1 });
    expect(unwrapSasPayBody({ success: false, error: {} })).toBeUndefined();
  });
});

describe('Adaptateur SasPay — création (1-21B)', () => {
  const request = {
    merchantReference: 'SM0123456789ABCDEF01234567',
    amount: 3000,
    currency: 'XAF' as const,
    payerPhone: null,
    description: 'Abonnement',
    customer: { email: 'gerant@example.com', name: 'Gérant' },
    returnUrl:
      'https://app.example.com/app/organization/subscription?payment=x',
  };
  const providerWith = (transport: SasPayTransport) =>
    new SasPayPaymentProvider({
      environment: 'sandbox',
      secretKey: TEST,
      transport,
    });
  const reply = (status: number, data?: unknown) => () =>
    Promise.resolve({
      status,
      bodyText: JSON.stringify(
        data === undefined ? {} : { success: true, data, code: status },
      ),
    });

  it('corps envoyé : montant décimal, XAF, CM, métadonnée, retour serveur ; clé seulement en en-tête', async () => {
    let sent: SasPayHttpRequest | undefined;
    const provider = providerWith(async (req) => {
      sent = req;
      return reply(201, {
        id: '0f0e0d0c-0b0a-4908-8706-050403020100',
        checkout_url: 'https://pay.saspay.me/checkout/abc',
        metadata: { merchantReference: request.merchantReference },
      })();
    });
    await expect(provider.initiate(request)).resolves.toEqual({
      outcome: 'accepted',
      providerReference: '0f0e0d0c-0b0a-4908-8706-050403020100',
      redirectUrl: 'https://pay.saspay.me/checkout/abc',
    });
    expect(sent!.url).toBe('https://api.saspay.me/api/v1/checkout-sessions/');
    expect(sent!.headers.Authorization).toBe(`Bearer ${TEST}`);
    const body = JSON.parse(sent!.body!) as Record<string, unknown>;
    expect(body).toMatchObject({
      amount: '3000.00',
      currency: 'XAF',
      country: 'CM',
      customer_email: 'gerant@example.com',
      return_url: request.returnUrl,
      metadata: { merchantReference: request.merchantReference },
    });
    expect(JSON.stringify(body)).not.toContain(TEST);
  });

  it('classement des réponses : 400/422 refus, 401/403/404/429 et non transmis indisponible, 409/5xx/perdu incertain', async () => {
    for (const status of [400, 422]) {
      await expect(
        providerWith(reply(status)).initiate(request),
      ).resolves.toEqual({ outcome: 'rejected' });
    }
    for (const status of [401, 403, 404, 429]) {
      await expect(
        providerWith(reply(status)).initiate(request),
      ).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
    }
    await expect(
      providerWith(() =>
        Promise.reject(new SasPayTransportError('not-sent')),
      ).initiate(request),
    ).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
    for (const status of [409, 500, 502]) {
      await expect(
        providerWith(reply(status)).initiate(request),
      ).rejects.toBeInstanceOf(PaymentProviderUncertainError);
    }
    await expect(
      providerWith(() =>
        Promise.reject(new SasPayTransportError('unknown')),
      ).initiate(request),
    ).rejects.toBeInstanceOf(PaymentProviderUncertainError);
    // 201 inexploitable (page hors hôte autorisé) : session peut-être créée.
    await expect(
      providerWith(
        reply(201, {
          id: '0f0e0d0c-0b0a-4908-8706-050403020100',
          checkout_url: 'https://evil.example/x',
        }),
      ).initiate(request),
    ).rejects.toBeInstanceOf(PaymentProviderUncertainError);
  });

  it('sans payeur : rien n’est envoyé', async () => {
    const transport = jest.fn();
    await expect(
      providerWith(transport).initiate({ ...request, customer: undefined }),
    ).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
    expect(transport).not.toHaveBeenCalled();
  });
});
