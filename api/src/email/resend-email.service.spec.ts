import { ConfigService } from '@nestjs/config';
import { ResendEmailService } from './resend-email.service';

/**
 * Aucun appel réseau réel dans ces tests (1-10B) : `global.fetch` est
 * toujours remplacé par un mock avant chaque cas — jamais l'implémentation
 * native.
 */
describe('ResendEmailService', () => {
  let originalFetch: typeof fetch;
  let fetchMock: jest.Mock;

  const VALID_CONFIG: Record<string, string> = {
    RESEND_API_KEY: 're_test_key_123',
    EMAIL_FROM: 'no-reply@stockmaster.test',
    PUBLIC_APP_URL: 'https://app.stockmaster.test',
  };

  function buildService(config: Record<string, string | undefined>) {
    const configService = {
      get: jest.fn((key: string) => config[key]),
    } as unknown as ConfigService;
    return new ResendEmailService(configService);
  }

  const PAYLOAD = {
    to: 'invitee@example.com',
    organizationName: 'Acme Corp',
    role: 'admin',
    token: 'raw-token-value-àé&<script>',
    expiresAt: new Date('2026-01-04T00:00:00.000Z'),
  };

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  // ---- Config absente/invalide → aucun appel réseau ----
  it.each([
    ['RESEND_API_KEY manquant', { ...VALID_CONFIG, RESEND_API_KEY: undefined }],
    ['EMAIL_FROM manquant', { ...VALID_CONFIG, EMAIL_FROM: undefined }],
    ['PUBLIC_APP_URL manquant', { ...VALID_CONFIG, PUBLIC_APP_URL: undefined }],
    [
      'PUBLIC_APP_URL non-absolue',
      { ...VALID_CONFIG, PUBLIC_APP_URL: '/relative/path' },
    ],
    [
      'PUBLIC_APP_URL protocole non http(s)',
      { ...VALID_CONFIG, PUBLIC_APP_URL: 'ftp://app.stockmaster.test' },
    ],
    [
      'PUBLIC_APP_URL invalide (non parsable)',
      { ...VALID_CONFIG, PUBLIC_APP_URL: 'not-a-url' },
    ],
  ])('%s → statut manual, aucun fetch appelé', async (_label, config) => {
    const service = buildService(config);
    const status = await service.sendInvitationEmail(PAYLOAD);
    expect(status).toBe('manual');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ---- Succès ----
  it('config complète + provider 2xx → statut sent, payload exact envoyé au provider', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const service = buildService(VALID_CONFIG);

    const status = await service.sendInvitationEmail(PAYLOAD);

    expect(status).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${VALID_CONFIG.RESEND_API_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.from).toBe(VALID_CONFIG.EMAIL_FROM);
    expect(body.to).toEqual([PAYLOAD.to]);
    expect(typeof body.subject).toBe('string');
    expect(body.subject as string).toContain('Acme Corp');
  });

  // ---- URL encodée correctement dans le lien d'acceptation ----
  it('le token est encodé (encodeURIComponent) dans le lien d’acceptation', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const service = buildService(VALID_CONFIG);

    await service.sendInvitationEmail(PAYLOAD);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      html: string;
      text: string;
    };
    const expectedUrl = `https://app.stockmaster.test/auth/invitations/accept?token=${encodeURIComponent(PAYLOAD.token)}`;
    expect(body.text).toContain(expectedUrl);
    expect(body.html).toContain(expectedUrl);
    // Le token brut n'apparaît JAMAIS en clair (non encodé) dans le corps :
    expect(body.html).not.toContain(PAYLOAD.token);
  });

  // ---- HTML échappé : aucune donnée client injectée sans échappement ----
  it('le nom d’organisation est échappé dans le HTML (aucune injection)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const service = buildService(VALID_CONFIG);
    const maliciousPayload = {
      ...PAYLOAD,
      organizationName: '<script>alert(1)</script> & "Cie"',
    };

    await service.sendInvitationEmail(maliciousPayload);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { html: string };
    expect(body.html).not.toContain('<script>');
    expect(body.html).toContain('&lt;script&gt;');
    expect(body.html).toContain('&amp;');
    expect(body.html).toContain('&quot;Cie&quot;');
  });

  // ---- Échec provider (statut non-2xx) ----
  it('provider répond non-ok (ex. 401/500) → statut failed, jamais une exception', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const service = buildService(VALID_CONFIG);

    const status = await service.sendInvitationEmail(PAYLOAD);

    expect(status).toBe('failed');
  });

  // ---- Time-out / erreur réseau ----
  it('fetch rejette (réseau/AbortError) → statut failed, jamais une exception propagée', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('aborted'), {
        name: 'AbortError',
      }),
    );
    const service = buildService(VALID_CONFIG);

    await expect(service.sendInvitationEmail(PAYLOAD)).resolves.toBe('failed');
  });

  // ---- Timeout explicite via AbortController ----
  it('passe un AbortSignal à fetch (timeout explicite)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const service = buildService(VALID_CONFIG);

    await service.sendInvitationEmail(PAYLOAD);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  // ---- Aucune fuite de secret/token dans les logs ----
  it('jamais de log contenant le token brut, la clé API ou la réponse provider', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('resend down, secret leak attempt'));
    const service = buildService(VALID_CONFIG);

    await service.sendInvitationEmail(PAYLOAD);

    const allLogged = [
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
    ]
      .flat()
      .map((entry) => String(entry))
      .join('\n');
    expect(allLogged).not.toContain(PAYLOAD.token);
    expect(allLogged).not.toContain(VALID_CONFIG.RESEND_API_KEY);
  });
});
