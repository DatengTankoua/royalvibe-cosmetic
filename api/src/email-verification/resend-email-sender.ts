import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailDeliveryError, EmailSender, OutgoingEmail } from './email-sender';

/** Point d'entrée fixe de l'API Resend (jamais configurable par requête). */
export const RESEND_EMAILS_ENDPOINT = 'https://api.resend.com/emails';

/** Délai borné d'un appel Resend ; aucune relance automatique. */
export const RESEND_TIMEOUT_MS = 10_000;

const ADDRESS_PATTERN = /^[^\s<>@",;]+@[^\s<>@",;]+\.[^\s<>@",;]+$/;

/** 1-16C.1 — Adresse simple (sans nom, sans liste, sans retour à la ligne). */
export function isValidReplyTo(value: string | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 320 &&
    !/[\r\n]/.test(value) &&
    ADDRESS_PATTERN.test(value)
  );
}

/**
 * `EMAIL_FROM` : `adresse@domaine` ou `Nom <adresse@domaine>`. Aucun retour
 * à la ligne (injection d'en-têtes), aucune liste d'adresses.
 */
export function isValidEmailFrom(value: string | undefined): boolean {
  if (!value) return false;
  const from = value.trim();
  if (from.length === 0 || from.length > 320 || /[\r\n]/.test(from)) {
    return false;
  }
  const named = /^([^<>"\r\n]{1,100}) <([^<>]+)>$/.exec(from);
  return ADDRESS_PATTERN.test(named ? named[2] : from);
}

function isTimeoutError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    ((err as { name?: unknown }).name === 'TimeoutError' ||
      (err as { name?: unknown }).name === 'AbortError')
  );
}

/**
 * Expéditeur Resend (1-13A) via `fetch` natif — aucun SDK ajouté.
 *
 * - `Authorization: Bearer <RESEND_API_KEY>`, `Idempotency-Key` par émission ;
 * - timeout borné (`AbortSignal.timeout`), redirections refusées ;
 * - statut HTTP contrôlé ; corps de réponse jamais lu ni journalisé ;
 * - aucune boucle de retry : un échec remonte en `EmailDeliveryError`.
 *
 * Configuration lue à chaque envoi (comme `PUBLIC_APP_URL` des invitations).
 */
@Injectable()
export class ResendEmailSender implements EmailSender {
  constructor(private readonly config: ConfigService) {}

  private apiKey(): string {
    return (this.config.get<string>('RESEND_API_KEY') ?? '').trim();
  }

  private from(): string | undefined {
    return this.config.get<string>('EMAIL_FROM')?.trim();
  }

  isConfigured(): boolean {
    return this.apiKey().length > 0 && isValidEmailFrom(this.from());
  }

  async send(email: OutgoingEmail): Promise<void> {
    if (!this.isConfigured()) {
      throw new EmailDeliveryError('not_configured');
    }
    // Reply-To invalide : refus AVANT tout appel (jamais d'en-tête injecté).
    if (email.replyTo !== undefined && !isValidReplyTo(email.replyTo)) {
      throw new EmailDeliveryError('rejected');
    }

    let response: Response;
    try {
      response = await fetch(RESEND_EMAILS_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey()}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': email.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.from(),
          to: [email.to],
          subject: email.subject,
          html: email.html,
          text: email.text,
          ...(email.replyTo !== undefined ? { reply_to: email.replyTo } : {}),
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
    } catch (err) {
      throw new EmailDeliveryError(isTimeoutError(err) ? 'timeout' : 'network');
    }

    // Corps libéré sans lecture : jamais journalisé ni propagé.
    await response.body?.cancel().catch(() => undefined);

    if (!response.ok) {
      throw new EmailDeliveryError('rejected', response.status);
    }
  }
}
