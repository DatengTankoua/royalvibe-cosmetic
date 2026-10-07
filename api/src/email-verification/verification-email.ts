import type { AppLocale } from '../common/i18n/locale';

/** Route frontend de confirmation (1-13A) : exclue du service worker et du cache. */
export const EMAIL_VERIFICATION_PATH = '/auth/verify-email';

/**
 * Lien de confirmation construit depuis l'origine validée de
 * `PUBLIC_APP_URL` (jamais `Host`/`Origin`) : token encodé, jamais
 * journalisé ni persisté en clair.
 */
export function buildEmailVerificationUrl(
  origin: string,
  token: string,
): string {
  return `${origin}${EMAIL_VERIFICATION_PATH}?token=${encodeURIComponent(token)}`;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** Texte brut : aucun retour à la ligne injecté par une valeur dynamique. */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export interface VerificationEmailContent {
  subject: string;
  html: string;
  text: string;
}

/**
 * Email simple, HTML et texte, valeurs dynamiques échappées. 1-16G : dans
 * la langue du DESTINATAIRE (`User.locale`, repli français).
 */
export function buildVerificationEmail(
  name: string,
  verificationUrl: string,
  locale: AppLocale = 'fr',
): VerificationEmailContent {
  if (locale === 'en') return buildVerificationEmailEn(name, verificationUrl);
  const safeName = escapeHtml(singleLine(name));
  const safeUrl = escapeHtml(verificationUrl);
  const subject = 'Confirmez votre adresse email – Stock Master';

  const html = `<!doctype html>
<html lang="fr">
  <body style="font-family: Arial, sans-serif; color: #111827; line-height: 1.5;">
    <p>Bonjour ${safeName},</p>
    <p>Confirmez votre adresse email pour accéder à votre compte Stock Master.</p>
    <p>
      <a href="${safeUrl}" style="display: inline-block; padding: 10px 16px; background: #062B5C; color: #ffffff; text-decoration: none; border-radius: 6px;">Confirmer mon adresse email</a>
    </p>
    <p>Ce lien est valable 24 heures et ne peut être utilisé qu'une seule fois.</p>
    <p style="color: #6b7280; font-size: 13px;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br />${safeUrl}</p>
    <p style="color: #6b7280; font-size: 13px;">Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
  </body>
</html>`;

  const text = [
    `Bonjour ${singleLine(name)},`,
    '',
    'Confirmez votre adresse email pour accéder à votre compte Stock Master :',
    verificationUrl,
    '',
    "Ce lien est valable 24 heures et ne peut être utilisé qu'une seule fois.",
    "Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.",
  ].join('\n');

  return { subject, html, text };
}

function buildVerificationEmailEn(
  name: string,
  verificationUrl: string,
): VerificationEmailContent {
  const safeName = escapeHtml(singleLine(name));
  const safeUrl = escapeHtml(verificationUrl);
  const subject = 'Confirm your email address – Stock Master';
  const html = `<!doctype html>
<html lang="en">
  <body style="font-family: Arial, sans-serif; color: #111827; line-height: 1.5;">
    <p>Hello ${safeName},</p>
    <p>Confirm your email address to access your Stock Master account.</p>
    <p>
      <a href="${safeUrl}" style="display: inline-block; padding: 10px 16px; background: #062B5C; color: #ffffff; text-decoration: none; border-radius: 6px;">Confirm my email address</a>
    </p>
    <p>This link is valid for 24 hours and can only be used once.</p>
    <p style="color: #6b7280; font-size: 13px;">If the button does not work, copy this link into your browser:<br />${safeUrl}</p>
    <p style="color: #6b7280; font-size: 13px;">If you did not make this request, ignore this email.</p>
  </body>
</html>`;
  const text = [
    `Hello ${singleLine(name)},`,
    '',
    'Confirm your email address to access your Stock Master account:',
    verificationUrl,
    '',
    'This link is valid for 24 hours and can only be used once.',
    'If you did not make this request, ignore this email.',
  ].join('\n');
  return { subject, html, text };
}
