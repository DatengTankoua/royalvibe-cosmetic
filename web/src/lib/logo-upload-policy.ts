// 1-12D — Politique d'upload du logo d'organisation côté frontend : miroir
// du contrat backend (api/src/organizations/logo/logo-validation.ts). Aide
// à la saisie uniquement : le backend reste l'autorité finale (contenu,
// format réel, animation, dimensions ; erreurs 400/413 stables).
export const LOGO_ACCEPT =
  "image/png,image/webp,image/jpeg,.png,.webp,.jpg,.jpeg";

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

// 1-16G : aide affichée dans `organization` (`branding.logoHelp`).
