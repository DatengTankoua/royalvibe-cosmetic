import {
  AntiAbuseConfigError,
  normalizeAccountEmail,
  resolveAntiAbuseConfig,
} from './anti-abuse-config';

describe('1-18C — seuils des plafonds persistants', () => {
  it('défauts : 10 échecs / 15 min par compte ; 5 e-mails / 24 h par destinataire', () => {
    expect(resolveAntiAbuseConfig({})).toEqual({
      accountFailures: {
        scope: 'auth-account-failure',
        limit: 10,
        windowMs: 900_000,
      },
      challengedFailures: {
        scope: 'auth-challenged-failure',
        limit: 5,
        windowMs: 900_000,
      },
      invitationEmailRecipient: {
        scope: 'invitation-email-recipient',
        limit: 5,
        windowMs: 86_400_000,
      },
    });
  });

  it('valeurs configurées dans les bornes', () => {
    const config = resolveAntiAbuseConfig({
      AUTH_ACCOUNT_FAILURE_LIMIT: '5',
      AUTH_ACCOUNT_FAILURE_WINDOW_SECONDS: '600',
      INVITATION_EMAIL_RECIPIENT_LIMIT: '3',
      INVITATION_EMAIL_RECIPIENT_WINDOW_SECONDS: '3600',
    });
    expect(config.accountFailures).toMatchObject({
      limit: 5,
      windowMs: 600_000,
    });
    expect(config.invitationEmailRecipient).toMatchObject({
      limit: 3,
      windowMs: 3_600_000,
    });
  });

  it.each([
    ['AUTH_ACCOUNT_FAILURE_LIMIT', '2'],
    ['AUTH_ACCOUNT_FAILURE_LIMIT', 'dix'],
    ['AUTH_ACCOUNT_FAILURE_WINDOW_SECONDS', '7200'],
    ['INVITATION_EMAIL_RECIPIENT_LIMIT', '0'],
    ['INVITATION_EMAIL_RECIPIENT_WINDOW_SECONDS', '60'],
    ['INVITATION_EMAIL_RECIPIENT_LIMIT', '-1'],
    ['AUTH_CHALLENGED_FAILURE_LIMIT', '0'],
    ['AUTH_CHALLENGED_FAILURE_LIMIT', '21'],
  ])('refus : %s=%s', (name, value) => {
    expect(() => resolveAntiAbuseConfig({ [name]: value })).toThrow(
      AntiAbuseConfigError,
    );
  });

  it('normalisation du modèle User : trim + minuscules', () => {
    expect(normalizeAccountEmail('  Ada@Example.COM ')).toBe('ada@example.com');
  });
});
