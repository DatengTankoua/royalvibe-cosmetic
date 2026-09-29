// 1-12C — Miroir des limites backend (api/src/common/validation/name-rules.ts
// et api/src/organizations/logo/logo-validation.ts). Aide à la saisie
// uniquement : le backend reste l'autorité finale (400/413 stables).
export const ORGANIZATION_NAME_MAX_LENGTH = 20;
export const USER_NAME_MAX_LENGTH = 20;

export const ORGANIZATION_NAME_HINT = `${ORGANIZATION_NAME_MAX_LENGTH} caractères maximum.`;
export const USER_NAME_HINT = `${USER_NAME_MAX_LENGTH} caractères maximum.`;

// Logo d'organisation : PNG ou WebP, 2 Mo et 2048 × 2048 px maximum.
export const LOGO_ACCEPT = "image/png,image/webp,.png,.webp";
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_HINT = "PNG ou WebP, 2 Mo et 2048 × 2048 pixels maximum.";
