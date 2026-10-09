import { escapeHtml } from '../email-verification/verification-email';
import type { AppLocale } from '../common/i18n/locale';
import type { EmailContent } from '../password-reset/password-reset-email';

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

const FOOTER_STYLE = 'color: #6b7280; font-size: 13px;';
const BUTTON_STYLE =
  'display: inline-block; padding: 10px 16px; background: #062B5C; color: #ffffff; text-decoration: none; border-radius: 6px;';

/**
 * 1-18B — Lien de création de compte envoyé à l'adresse INVITÉE. Ce lien,
 * et non celui remis au créateur, prouve le contrôle de la boîte : le nom et
 * le mot de passe sont choisis après l'avoir ouvert. Valeurs échappées ;
 * langue de la page qui a demandé l'envoi (aucun compte, donc aucune
 * préférence enregistrée).
 */
export function buildInvitationAccountEmail(
  organizationName: string,
  accountUrl: string,
  locale: AppLocale = 'fr',
): EmailContent {
  const organization = singleLine(organizationName);
  const safeOrganization = escapeHtml(organization);
  const safeUrl = escapeHtml(accountUrl);
  if (locale === 'en') {
    const html = `<!doctype html>
<html lang="en">
  <body style="font-family: Arial, sans-serif; color: #111827; line-height: 1.5;">
    <p>Hello,</p>
    <p>You have been invited to join ${safeOrganization} on Stock Master. Create your account to accept the invitation.</p>
    <p>
      <a href="${safeUrl}" style="${BUTTON_STYLE}">Create my account</a>
    </p>
    <p>This link is valid for 24 hours at most and can only be used once.</p>
    <p style="${FOOTER_STYLE}">If the button does not work, copy this link into your browser:<br />${safeUrl}</p>
    <p style="${FOOTER_STYLE}">If you were not expecting this invitation, ignore this email: no account will be created.</p>
  </body>
</html>`;
    const text = [
      'Hello,',
      '',
      `You have been invited to join ${organization} on Stock Master. Create your account to accept the invitation:`,
      accountUrl,
      '',
      'This link is valid for 24 hours at most and can only be used once.',
      'If you were not expecting this invitation, ignore this email: no account will be created.',
    ].join('\n');
    return {
      subject: 'Create your Stock Master account',
      html,
      text,
    };
  }
  const html = `<!doctype html>
<html lang="fr">
  <body style="font-family: Arial, sans-serif; color: #111827; line-height: 1.5;">
    <p>Bonjour,</p>
    <p>Vous êtes invité à rejoindre ${safeOrganization} sur Stock Master. Créez votre compte pour accepter l'invitation.</p>
    <p>
      <a href="${safeUrl}" style="${BUTTON_STYLE}">Créer mon compte</a>
    </p>
    <p>Ce lien est valable 24 heures au plus et ne peut être utilisé qu'une seule fois.</p>
    <p style="${FOOTER_STYLE}">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br />${safeUrl}</p>
    <p style="${FOOTER_STYLE}">Si vous n'attendiez pas cette invitation, ignorez cet email : aucun compte ne sera créé.</p>
  </body>
</html>`;
  const text = [
    'Bonjour,',
    '',
    `Vous êtes invité à rejoindre ${organization} sur Stock Master. Créez votre compte pour accepter l'invitation :`,
    accountUrl,
    '',
    "Ce lien est valable 24 heures au plus et ne peut être utilisé qu'une seule fois.",
    "Si vous n'attendiez pas cette invitation, ignorez cet email : aucun compte ne sera créé.",
  ].join('\n');
  return {
    subject: 'Créez votre compte Stock Master',
    html,
    text,
  };
}
