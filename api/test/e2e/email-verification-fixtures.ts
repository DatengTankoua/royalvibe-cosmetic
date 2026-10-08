import type { INestApplication } from '@nestjs/common';
import {
  EmailDeliveryError,
  type EmailSender,
  type OutgoingEmail,
} from '../../src/email-verification/email-sender';
import { EmailVerificationService } from '../../src/email-verification/email-verification.service';

/**
 * 1-13A — Expéditeur simulé des E2E (jamais Resend, jamais de réseau).
 * Injecté par `overrideProvider(EMAIL_SENDER)` : aucun bypass de production.
 */
export class RecordingEmailSender implements EmailSender {
  readonly sent: OutgoingEmail[] = [];
  configured = true;
  /** Échec simulé du fournisseur (null = succès). */
  failure: EmailDeliveryError | null = null;
  /** Appelé après chaque envoi accepté (ex. confirmation automatique). */
  onSent: ((email: OutgoingEmail) => Promise<void>) | null = null;
  attempts = 0;

  isConfigured(): boolean {
    return this.configured;
  }

  async send(email: OutgoingEmail): Promise<void> {
    this.attempts += 1;
    if (this.failure) throw this.failure;
    this.sent.push(email);
    if (this.onSent) await this.onSent(email);
  }

  sentTo(address: string): OutgoingEmail[] {
    return this.sent.filter((email) => email.to === address);
  }

  reset(): void {
    this.sent.length = 0;
    this.attempts = 0;
    this.failure = null;
    this.configured = true;
  }
}

/** Token brut extrait du lien (texte) d'un email de vérification simulé. */
export function verificationTokenFrom(email: OutgoingEmail): string {
  const match = /\/auth\/verify-email\?token=([^\s"&]+)/.exec(email.text);
  if (!match) throw new Error('No verification link in email');
  return decodeURIComponent(match[1]);
}

/** Date fixe des fixtures créées explicitement comme vérifiées. */
export const E2E_EMAIL_VERIFIED_AT = new Date('2026-01-01T00:00:00.000Z');

/** Origine publique de repli des suites qui n'en définissent pas. */
const E2E_FALLBACK_PUBLIC_APP_URL = 'https://app.email-e2e.test';

/**
 * Expéditeur simulé des suites dont le sujet n'est PAS la vérification :
 * chaque lien envoyé est aussitôt consommé via le service réel (même preuve
 * qu'un clic), pour que leurs parcours inscription/invitation → login
 * restent inchangés. Les scénarios de vérification utilisent un
 * `RecordingEmailSender` sans confirmation automatique.
 */
export function createE2eEmailSender(): RecordingEmailSender {
  process.env.PUBLIC_APP_URL ??= E2E_FALLBACK_PUBLIC_APP_URL;
  return new RecordingEmailSender();
}

export function autoConfirmVerificationEmails(
  app: INestApplication,
  sender: RecordingEmailSender,
): void {
  const verification = app.get(EmailVerificationService);
  sender.onSent = (email) => verification.confirm(verificationTokenFrom(email));
}
