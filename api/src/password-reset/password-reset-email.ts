import { escapeHtml } from '../email-verification/verification-email';

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

/** Email de réinitialisation : français, HTML et texte, valeurs échappées. */
export function buildPasswordResetEmail(
  name: string,
  resetUrl: string,
): EmailContent {
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

export const PASSWORD_CHANGED_SUBJECT =
  'Votre mot de passe Stock Master a été modifié.';

/** Notification après réinitialisation : ni mot de passe, ni token, ni lien de connexion automatique. */
export function buildPasswordChangedEmail(name: string): EmailContent {
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
