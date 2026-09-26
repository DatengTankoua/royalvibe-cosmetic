import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EmailDeliveryStatus,
  EmailService,
  InvitationEmailPayload,
} from './email.service';

const RESEND_API_URL = 'https://api.resend.com/emails';

// Aucun retry automatique (1-10B, §3) : un seul essai, borné par timeout.
const SEND_TIMEOUT_MS = 8_000;

const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrateur',
  seller: 'Vendeur',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** URL absolue http/https requise (1-10B) : jamais de valeur par défaut de production. */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

interface ResendConfig {
  apiKey: string;
  emailFrom: string;
  publicAppUrl: string;
}

@Injectable()
export class ResendEmailService extends EmailService {
  constructor(private readonly configService: ConfigService) {
    super();
  }

  /**
   * Config relue à CHAQUE appel (jamais mise en cache au constructeur) :
   * seule cette méthode décide "configuré ou non", jamais une valeur
   * par défaut de production. Absence/valeur invalide d'UNE SEULE des 3
   * variables → non configuré (aucun appel réseau, statut `manual`).
   */
  private readConfig(): ResendConfig | null {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    const emailFrom = this.configService.get<string>('EMAIL_FROM');
    const publicAppUrl = this.configService.get<string>('PUBLIC_APP_URL');
    if (!apiKey || !emailFrom || !publicAppUrl) return null;
    if (!isAbsoluteHttpUrl(publicAppUrl)) return null;
    return { apiKey, emailFrom, publicAppUrl };
  }

  async sendInvitationEmail(
    payload: InvitationEmailPayload,
  ): Promise<EmailDeliveryStatus> {
    const config = this.readConfig();
    if (!config) return 'manual';

    const acceptUrl = `${config.publicAppUrl.replace(/\/+$/, '')}/auth/invitations/accept?token=${encodeURIComponent(payload.token)}`;
    const roleLabel = ROLE_LABELS[payload.role] ?? escapeHtml(payload.role);
    const organizationNameSafe = escapeHtml(payload.organizationName);
    const subject = `Invitation à rejoindre ${payload.organizationName} sur Stock Master`;
    const text = [
      `Vous êtes invité(e) à rejoindre ${payload.organizationName} sur Stock Master, avec le rôle ${roleLabel}.`,
      `Ce lien expire 72 heures après son émission (le ${payload.expiresAt.toISOString()}).`,
      `Pour accepter l'invitation : ${acceptUrl}`,
    ].join('\n\n');
    const html = `
      <p>Vous êtes invité(e) à rejoindre <strong>${organizationNameSafe}</strong> sur Stock Master, avec le rôle <strong>${roleLabel}</strong>.</p>
      <p>Ce lien expire 72 heures après son émission (le ${payload.expiresAt.toISOString()}).</p>
      <p><a href="${acceptUrl}">Accepter l'invitation</a></p>
    `.trim();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const response = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: config.emailFrom,
          to: [payload.to],
          subject,
          text,
          html,
        }),
        signal: controller.signal,
      });
      // Seule l'acceptation par le provider (statut HTTP) est constatée —
      // jamais une garantie de remise réelle au destinataire.
      return response.ok ? 'sent' : 'failed';
    } catch {
      // Time-out (AbortError) ou échec réseau : jamais journalisé/rethrow —
      // aucun détail du provider ne doit atteindre l'appelant HTTP.
      return 'failed';
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
