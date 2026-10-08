import { ConfigService } from '@nestjs/config';
import { EmailDeliveryError } from './email-sender';
import {
  RESEND_EMAILS_ENDPOINT,
  RESEND_TIMEOUT_MS,
  ResendEmailSender,
  isValidEmailFrom,
} from './resend-email-sender';

const API_KEY = 're_test_key_never_real';
const EMAIL = {
  to: 'ada@example.com',
  subject: 'Sujet',
  html: '<p>html</p>',
  text: 'texte',
  idempotencyKey: 'email-verification-u1-1700000000000',
};

function makeSender(env: Record<string, string | undefined>) {
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  return new ResendEmailSender(config);
}

describe('ResendEmailSender (1-13A)', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    // Aucun appel réseau réel : `fetch` est TOUJOURS simulé.
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  const configured = () =>
    makeSender({
      RESEND_API_KEY: API_KEY,
      EMAIL_FROM: 'Stock Master <no-reply@example.com>',
    });

  it.each([
    ['clé absente', { EMAIL_FROM: 'no-reply@example.com' }],
    ['clé vide', { RESEND_API_KEY: '  ', EMAIL_FROM: 'no-reply@example.com' }],
    ['expéditeur absent', { RESEND_API_KEY: API_KEY }],
    [
      'expéditeur invalide',
      { RESEND_API_KEY: API_KEY, EMAIL_FROM: 'pas-une-adresse' },
    ],
  ])('%s → non configuré, aucun appel', async (_label, env) => {
    const sender = makeSender(env);
    expect(sender.isConfigured()).toBe(false);
    await expect(sender.send(EMAIL)).rejects.toMatchObject({
      reason: 'not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requête exacte : POST Resend, Bearer, Idempotency-Key, timeout, sans redirection', async () => {
    fetchMock.mockResolvedValue(new Response('{"id":"x"}', { status: 200 }));
    await configured().send(EMAIL);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RESEND_EMAILS_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': EMAIL.idempotencyKey,
    });
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'Stock Master <no-reply@example.com>',
      to: ['ada@example.com'],
      subject: 'Sujet',
      html: '<p>html</p>',
      text: 'texte',
    });
    expect(RESEND_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  it.each([400, 401, 403, 422, 429, 500, 503])(
    'HTTP %i → rejected, statut conservé, corps jamais propagé',
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response('{"message":"provider secret detail"}', { status }),
      );
      const error: unknown = await configured()
        .send(EMAIL)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EmailDeliveryError);
      expect(error).toMatchObject({
        reason: 'rejected',
        providerStatus: status,
      });
      expect(String((error as Error).message)).not.toContain('provider secret');
      expect(fetchMock).toHaveBeenCalledTimes(1); // aucune relance
    },
  );

  it('timeout → reason timeout, aucune relance', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
    );
    await expect(configured().send(EMAIL)).rejects.toMatchObject({
      reason: 'timeout',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fournisseur injoignable → reason network, aucune relance', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(configured().send(EMAIL)).rejects.toMatchObject({
      reason: 'network',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('isValidEmailFrom : adresses simples ou nommées, jamais d’injection', () => {
    expect(isValidEmailFrom('no-reply@example.com')).toBe(true);
    expect(isValidEmailFrom('Stock Master <no-reply@example.com>')).toBe(true);
    expect(isValidEmailFrom(undefined)).toBe(false);
    expect(isValidEmailFrom('')).toBe(false);
    expect(isValidEmailFrom('a@b.co\r\nBcc: x@y.z')).toBe(false);
    expect(isValidEmailFrom('a@b.co, c@d.co')).toBe(false);
    expect(isValidEmailFrom('Nom <pas-une-adresse>')).toBe(false);
  });
});
