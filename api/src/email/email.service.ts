/** Statuts de livraison exposés à l'appelant (1-10B) : jamais une garantie de remise, seulement l'issue de l'appel provider. */
export type EmailDeliveryStatus = 'sent' | 'manual' | 'failed';

export interface InvitationEmailPayload {
  to: string;
  organizationName: string;
  role: string;
  /** Jeton brut : utilisé UNIQUEMENT pour construire le lien, jamais journalisé. */
  token: string;
  expiresAt: Date;
}

/**
 * Abstraction injectable minimale (1-10B) : un seul cas d'usage (email
 * d'invitation). N'expose jamais l'erreur brute du provider à l'appelant —
 * la méthode ne rejette jamais, elle renvoie toujours un `EmailDeliveryStatus`.
 */
export abstract class EmailService {
  abstract sendInvitationEmail(
    payload: InvitationEmailPayload,
  ): Promise<EmailDeliveryStatus>;
}
