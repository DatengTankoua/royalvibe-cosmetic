/**
 * 1-13B — Version de session serveur (`User.authVersion`).
 *
 * - champ absent (comptes historiques) = version 0 ;
 * - chaque JWT émis porte la version courante dans le claim `ver` ;
 * - JWT historique sans `ver` = version 0 uniquement ;
 * - `ver` présent : entier sûr ≥ 0, jamais converti (`"1"`, `1.5`, `null`
 *   → invalide).
 * Une réinitialisation de mot de passe incrémente la version : tous les JWT
 * antérieurs de l'utilisateur sont refusés, quelle que soit l'organisation.
 */
export const SESSION_VERSION_CLAIM = 'ver';

export const SESSION_REVOKED = 'SESSION_REVOKED';
export const SESSION_REVOKED_MESSAGE =
  'Votre session a expiré. Veuillez vous reconnecter.';

/** Version stockée : absente/invalide → 0. */
export function currentSessionVersion(user: {
  authVersion?: number | null;
}): number {
  const value = user.authVersion;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

/** Claim lu dans un payload VÉRIFIÉ ; `null` si présent mais invalide. */
export function sessionVersionFromClaims(
  payload: Readonly<Record<string, unknown>> | null | undefined,
): number | null {
  if (!payload || !(SESSION_VERSION_CLAIM in payload)) return 0;
  const value = payload[SESSION_VERSION_CLAIM];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** Vrai seulement si le claim est valide ET égal à la version relue en base. */
export function isSessionCurrent(
  payload: Readonly<Record<string, unknown>> | null | undefined,
  user: { authVersion?: number | null },
): boolean {
  const claimed = sessionVersionFromClaims(payload);
  return claimed !== null && claimed === currentSessionVersion(user);
}

/** Filtre Mongo de la version lue (0 = champ absent, null ou 0). */
export function sessionVersionFilter(
  version: number,
): number | { $in: [null, 0] } {
  return version === 0 ? { $in: [null, 0] } : version;
}
