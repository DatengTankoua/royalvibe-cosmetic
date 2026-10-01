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

/** Email simple en français, HTML et texte, valeurs dynamiques échappées. */
export function buildVerificationEmail(
  name: string,
  verificationUrl: string,
): VerificationEmailContent {
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
