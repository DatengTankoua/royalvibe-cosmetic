import { escapeHtml } from '../email-verification/verification-email';
import type { AppLocale } from '../common/i18n/locale';

/** Route frontend de réinitialisation (1-13B) : exclue du service worker et du cache. */
export const PASSWORD_RESET_PATH = '/auth/reset-password';

/** Lien construit depuis l'origine validée de `PUBLIC_APP_URL` (jamais `Host`). */
export function buildPasswordResetUrl(origin: string, token: string): string {
  return `${origin}${PASSWORD_RESET_PATH}?token=${encodeURIComponent(token)}`;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

const FOOTER_STYLE = 'color: #6b7280; font-size: 13px;';

/**
 * Email de réinitialisation : HTML et texte, valeurs échappées. 1-16G :
 * langue du DESTINATAIRE (jamais celle de la personne qui l'a demandé).
 */
export function buildPasswordResetEmail(
  name: string,
  resetUrl: string,
  locale: AppLocale = 'fr',
): EmailContent {
  if (locale === 'en') return buildPasswordResetEmailEn(name, resetUrl);
  const safeName = escapeHtml(singleLine(name));
  const safeUrl = escapeHtml(resetUrl);
  const html = `<!doctype html>
<html lang="fr">
  <body style="font-family: Arial, sans-serif; color: #111827; line-height: 1.5;">
    <p>Bonjour ${safeName},</p>
    <p>Une réinitialisation du mot de passe de votre compte Stock Master a été demandée.</p>
    <p>
      <a href="${safeUrl}" style="display: inline-block; padding: 10px 16px; background: #062B5C; color: #ffffff; text-decoration: none; border-radius: 6px;">Choisir un nouveau mot de passe</a>
    </p>
    <p>Ce lien est valable 1 heure et ne peut être utilisé qu'une seule fois.</p>
    <p style="${FOOTER_STYLE}">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br />${safeUrl}</p>
    <p style="${FOOTER_STYLE}">Si vous n'êtes pas à l'origine de cette demande, ignorez cet email : votre mot de passe reste inchangé.</p>
  </body>
</html>`;
  const text = [
    `Bonjour ${singleLine(name)},`,
    '',
    'Une réinitialisation du mot de passe de votre compte Stock Master a été demandée.',
    'Choisissez un nouveau mot de passe :',
    resetUrl,
    '',
    "Ce lien est valable 1 heure et ne peut être utilisé qu'une seule fois.",
    "Si vous n'êtes pas à l'origine de cette demande, ignorez cet email : votre mot de passe reste inchangé.",
  ].join('\n');
  return {
    subject: 'Réinitialisation de votre mot de passe – Stock Master',
    html,
    text,
  };
}

function buildPasswordResetEmailEn(
  name: string,
  resetUrl: string,
): EmailContent {
  const safeName = escapeHtml(singleLine(name));
  const safeUrl = escapeHtml(resetUrl);
  const html = `<!doctype html>
<html lang="en">
  <body style="font-family: Arial, sans-serif; color: #111827; line-height: 1.5;">
    <p>Hello ${safeName},</p>
    <p>A password reset was requested for your Stock Master account.</p>
    <p>
      <a href="${safeUrl}" style="display: inline-block; padding: 10px 16px; background: #062B5C; color: #ffffff; text-decoration: none; border-radius: 6px;">Choose a new password</a>
    </p>
    <p>This link is valid for 1 hour and can only be used once.</p>
    <p style="${FOOTER_STYLE}">If the button does not work, copy this link into your browser:<br />${safeUrl}</p>
    <p style="${FOOTER_STYLE}">If you did not make this request, ignore this email: your password stays unchanged.</p>
  </body>
</html>`;
  const text = [
    `Hello ${singleLine(name)},`,
    '',
    'A password reset was requested for your Stock Master account.',
    'Choose a new password:',
    resetUrl,
    '',
    'This link is valid for 1 hour and can only be used once.',
    'If you did not make this request, ignore this email: your password stays unchanged.',
  ].join('\n');
  return {
    subject: 'Reset your password – Stock Master',
    html,
    text,
  };
}

export const PASSWORD_CHANGED_SUBJECT =
  'Votre mot de passe Stock Master a été modifié.';
export const PASSWORD_CHANGED_SUBJECT_EN =
  'Your Stock Master password has been changed.';

/** Notification après réinitialisation : ni mot de passe, ni token, ni lien de connexion automatique. */
export function buildPasswordChangedEmail(
  name: string,
  locale: AppLocale = 'fr',
): EmailContent {
  if (locale === 'en') {
    const safe = escapeHtml(singleLine(name));
    const html = `<!doctype html>
<html lang="en">
  <body style="font-family: Arial, sans-serif; color: #111827; line-height: 1.5;">
    <p>Hello ${safe},</p>
    <p>Your Stock Master password has been changed. Your previous sessions have been closed.</p>
    <p style="${FOOTER_STYLE}">If you did not make this change, use “Forgot your password?” on the login page and tell your shop manager.</p>
  </body>
</html>`;
    const text = [
      `Hello ${singleLine(name)},`,
      '',
      'Your Stock Master password has been changed. Your previous sessions have been closed.',
      'If you did not make this change, use “Forgot your password?” on the login page and tell your shop manager.',
    ].join('\n');
    return { subject: PASSWORD_CHANGED_SUBJECT_EN, html, text };
  }
  const safeName = escapeHtml(singleLine(name));
  const html = `<!doctype html>
<html lang="fr">
  <body style="font-family: Arial, sans-serif; color: #111827; line-height: 1.5;">
    <p>Bonjour ${safeName},</p>
    <p>Votre mot de passe Stock Master a été modifié. Vos anciennes sessions ont été fermées.</p>
    <p style="${FOOTER_STYLE}">Si vous n'êtes pas à l'origine de ce changement, utilisez « Mot de passe oublié ? » sur la page de connexion et prévenez le responsable de votre commerce.</p>
  </body>
</html>`;
  const text = [
    `Bonjour ${singleLine(name)},`,
    '',
    'Votre mot de passe Stock Master a été modifié. Vos anciennes sessions ont été fermées.',
    "Si vous n'êtes pas à l'origine de ce changement, utilisez « Mot de passe oublié ? » sur la page de connexion et prévenez le responsable de votre commerce.",
  ].join('\n');
  return { subject: PASSWORD_CHANGED_SUBJECT, html, text };
}
