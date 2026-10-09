/** Route frontend d'acceptation (1-12G) : exclue du service worker et du cache. */
export const INVITATION_ACCEPT_PATH = '/auth/invitations/accept';

/**
 * Origine publique de l'application web (1-12G), lue depuis
 * `PUBLIC_APP_URL` — jamais depuis l'en-tête `Host`/`Origin` de la requête.
 * Seule une origine http(s) nue est acceptée (pas d'identifiants, de
 * chemin, de query ni de fragment) : toute autre valeur → `null`.
 */
export function parsePublicAppOrigin(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  return url.origin;
}

/** Lien d'acceptation : token encodé, jamais journalisé ni persisté. */
export function buildInvitationUrl(origin: string, token: string): string {
  return `${origin}${INVITATION_ACCEPT_PATH}?token=${encodeURIComponent(token)}`;
}

/**
 * 1-18B — Route frontend de création de compte : son lien n'est envoyé qu'à
 * l'adresse invitée (jamais remis au créateur). Exclue du service worker.
 */
export const INVITATION_ACCOUNT_PATH = '/auth/invitations/create-account';

export function buildInvitationAccountUrl(
  origin: string,
  token: string,
): string {
  return `${origin}${INVITATION_ACCOUNT_PATH}?token=${encodeURIComponent(token)}`;
}
