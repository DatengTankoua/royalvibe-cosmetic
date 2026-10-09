// 1-18B — Invitation en cours pendant une connexion ou un changement de
// compte : le token est conservé dans `sessionStorage` (onglet courant
// uniquement, effacé à la fermeture), jamais dans l'URL d'une redirection,
// jamais dans `localStorage`, jamais journalisé. Retiré dès que le parcours
// se termine (acceptation, annulation, invitation invalide).
// Accès protégés : stockage indisponible (navigation privée, refus) → le
// parcours continue sans retour automatique.

const PENDING_INVITATION_KEY = "stockmaster_pending_invitation";

/** Page d'acceptation (chemin interne fixe, jamais lu depuis l'URL). */
export const INVITATION_ACCEPT_PATH = "/auth/invitations/accept";
/** Marqueur de retour de la page de connexion : `?next=invitation`. */
export const INVITATION_RETURN_MARKER = "invitation";
export const LOGIN_FOR_INVITATION_PATH = `/auth/login?next=${INVITATION_RETURN_MARKER}`;

export function savePendingInvitation(token: string): void {
  try {
    window.sessionStorage.setItem(PENDING_INVITATION_KEY, token);
  } catch {
    // Stockage indisponible : aucun retour automatique.
  }
}

export function readPendingInvitation(): string | null {
  try {
    return window.sessionStorage.getItem(PENDING_INVITATION_KEY);
  } catch {
    return null;
  }
}

export function clearPendingInvitation(): void {
  try {
    window.sessionStorage.removeItem(PENDING_INVITATION_KEY);
  } catch {
    // Rien à effacer.
  }
}
