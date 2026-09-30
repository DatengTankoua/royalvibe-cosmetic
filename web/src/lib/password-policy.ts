// 1-12G — Miroir de la politique backend (RegisterDto / AcceptInvitationDto :
// `@MinLength(6)`, `@MaxLength(100)`). Aide à la saisie uniquement : le
// backend reste l'autorité finale. Jamais de trim : les espaces font partie
// du mot de passe.
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 100;

export const PASSWORD_HINT = `Entre ${PASSWORD_MIN_LENGTH} et ${PASSWORD_MAX_LENGTH} caractères.`;
export const PASSWORD_MISMATCH_MESSAGE =
  "Les mots de passe ne correspondent pas.";

/**
 * Contrôle avant soumission d'un nouveau mot de passe et de sa confirmation.
 * Renvoie le message à afficher, ou `null` si la soumission peut partir.
 * La confirmation reste côté interface : seul `password` est envoyé à l'API.
 */
export function validateNewPassword(
  password: string,
  confirmation: string,
): string | null {
  if (
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    return `Le mot de passe doit contenir entre ${PASSWORD_MIN_LENGTH} et ${PASSWORD_MAX_LENGTH} caractères.`;
  }
  if (password !== confirmation) return PASSWORD_MISMATCH_MESSAGE;
  return null;
}
