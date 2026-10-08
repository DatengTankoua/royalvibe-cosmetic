/**
 * 1-13A — Contrat d'expédition d'emails, substituable (jeton DI
 * `EMAIL_SENDER`) : Resend en production, faux expéditeur en test. Aucun
 * bypass de production : la substitution passe uniquement par
 * `overrideProvider` dans les modules de test.
 */
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Une clé par émission logique (jamais réutilisée pour un autre lien). */
  idempotencyKey: string;
  /**
   * 1-16C.1 — Adresse de réponse unique, fixée par le serveur (jamais une
   * valeur client). Absente : comportement inchangé des emails existants.
   */
  replyTo?: string;
}

export interface EmailSender {
  /** Configuration serveur complète (clé API, expéditeur). */
  isConfigured(): boolean;
  /** Résout si le fournisseur a accepté la demande ; sinon `EmailDeliveryError`. */
  send(email: OutgoingEmail): Promise<void>;
}

export type EmailDeliveryFailureReason =
  'not_configured' | 'timeout' | 'network' | 'rejected';

/**
 * Échec d'envoi normalisé : seule une raison courte (et le statut HTTP du
 * fournisseur) est conservée — jamais la réponse brute, la clé ni le contenu.
 */
export class EmailDeliveryError extends Error {
  constructor(
    readonly reason: EmailDeliveryFailureReason,
    readonly providerStatus?: number,
  ) {
    super(`Email delivery failed: ${reason}`);
    this.name = 'EmailDeliveryError';
  }
}
