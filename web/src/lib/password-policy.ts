// 1-12G — Miroir de la politique backend (RegisterDto / AcceptInvitationDto :
// `@MinLength(6)`, `@MaxLength(100)`). Aide à la saisie uniquement : le
// backend reste l'autorité finale. Jamais de trim : les espaces font partie
// du mot de passe.
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 100;

// 1-16G : textes dans `auth` (`password.*`), avec ces limites en variables.

/**
 * Contrôle avant soumission d'un nouveau mot de passe et de sa confirmation.
 * Renvoie la clé du message à afficher (namespace `auth`), ou `null` si la
 * soumission peut partir. La confirmation reste côté interface : seul
 * `password` est envoyé à l'API.
 */
export function validateNewPassword(
  password: string,
  confirmation: string,
): "password.lengthError" | "password.mismatch" | null {
  if (
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    return "password.lengthError";
  }
  if (password !== confirmation) return "password.mismatch";
  return null;
}
