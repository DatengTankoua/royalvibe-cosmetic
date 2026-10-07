import { ConfigService } from '@nestjs/config';
import { EmailDeliveryError } from '../email-verification/email-sender';
import { ResendEmailSender } from '../email-verification/resend-email-sender';
import { buildSupportEmail } from './support-email';
import {
  classifyDeliveryFailure,
  supportFingerprint,
  supportReference,
} from './support.service';

/**
 * 1-16C.1 — Unitaires de l'assistance : Reply-To de l'expéditeur Resend
 * (fetch TOUJOURS simulé), classement des échecs, référence et empreinte
 * stables, message déterministe.
 */

const sender = () =>
  new ResendEmailSender({
    get: (key: string) =>
      ({
        RESEND_API_KEY: 're_test_key_never_real',
        EMAIL_FROM: 'Stock Master <noreply@stock-master.app>',
      })[key],
  } as unknown as ConfigService);

const BASE = {
  to: 'support@stock-master.app',
  subject: 'Sujet',
  html: '<p>x</p>',
  text: 'x',
  idempotencyKey: 'support-request/00000000-0000-4000-8000-000000000000',
};

describe('ResendEmailSender — Reply-To (1-16C.1)', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  it('reply_to transmis seulement s’il est fourni', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await sender().send({ ...BASE, replyTo: 'ada@example.com' });
    await sender().send(BASE);
    const bodies = fetchMock.mock.calls.map(
      ([, init]) =>
        JSON.parse((init as RequestInit).body as string) as Record<
          string,
          unknown
        >,
    );
    expect(bodies[0].reply_to).toBe('ada@example.com');
    expect(bodies[0].to).toEqual(['support@stock-master.app']);
    expect('reply_to' in bodies[1]).toBe(false);
  });

  it.each([
    'ada@example.com\r\nBcc: x@example.com',
    'Ada <ada@example.com>',
    'a@example.com, b@example.com',
    'pas-une-adresse',
  ])('Reply-To invalide refusé sans appel réseau : %p', async (replyTo) => {
    await expect(sender().send({ ...BASE, replyTo })).rejects.toMatchObject({
      reason: 'rejected',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('classifyDeliveryFailure', () => {
  it.each([
    [new EmailDeliveryError('not_configured'), 'failed'],
    [new EmailDeliveryError('timeout'), 'unknown'],
    [new EmailDeliveryError('network'), 'unknown'],
    [new EmailDeliveryError('rejected', 400), 'failed'],
    [new EmailDeliveryError('rejected', 422), 'failed'],
    [new EmailDeliveryError('rejected', 429), 'failed'],
    [new EmailDeliveryError('rejected', 409), 'unknown'],
    [new EmailDeliveryError('rejected', 500), 'unknown'],
    [new EmailDeliveryError('rejected', 503), 'unknown'],
    [new Error('inattendu'), 'unknown'],
  ])('%s → %s', (error, expected) => {
    expect(classifyDeliveryFailure(error)).toBe(expected);
  });
});

describe('référence, empreinte et message', () => {
  const content = {
    category: 'usage' as const,
    subject: 'Sujet',
    message: 'Message',
    page: null,
    appVersion: null,
  };

  it('référence stable dérivée de l’intention', () => {
    const id = '3f0c8c7e-1d2b-4c3a-9f8e-7d6c5b4a3a21';
    expect(supportReference(id)).toBe(supportReference(id));
    expect(supportReference(id)).toMatch(/^AS-[0-9A-F]{8}$/);
  });

  it('empreinte sensible à chaque champ du contenu', () => {
    const base = supportFingerprint(content);
    expect(supportFingerprint({ ...content })).toBe(base);
    for (const change of [
      { category: 'other' as const },
      { subject: 'Sujet ' },
      { message: 'Message!' },
      { page: '/app' },
      { appVersion: '1' },
    ]) {
      expect(supportFingerprint({ ...content, ...change })).not.toBe(base);
    }
  });

  it('message déterministe et échappé', () => {
    const input = {
      requestId: 'r',
      reference: 'AS-00000000',
      createdAt: new Date('2026-10-07T09:30:00.000Z'),
      category: 'technical' as const,
      subject: 'A & <b>',
      message: '<img src=x onerror=alert(1)>',
      page: null,
      appVersion: null,
      userId: 'u',
      organizationId: 'o',
      membershipId: 'm',
      context: {
        userName: 'Ada <x>',
        userEmail: 'ada@example.com',
        organizationName: 'Boutique "B"',
        organizationSlug: 'boutique-b',
        role: 'admin',
        permissions: ['support.contact'],
      },
    };
    const a = buildSupportEmail(input);
    const b = buildSupportEmail(input);
    expect(b).toEqual(a);
    expect(a.html).not.toContain('<img');
    expect(a.html).not.toContain('<b>');
    expect(a.html).toContain('Boutique &quot;B&quot;');
    expect(a.text).toContain(
      'Reçue le : 7 octobre 2026 à 10:30 (heure de Douala)',
    );
    expect(a.text).toContain('Rôle : Administrateur');
  });
});
