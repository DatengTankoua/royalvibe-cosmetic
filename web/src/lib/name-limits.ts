// 1-12C/1-12D — Miroir des limites de noms backend
// (api/src/common/validation/name-rules.ts, cohérence vérifiée par un test
// API). Aide à la saisie uniquement : le backend reste l'autorité finale.
export const ORGANIZATION_NAME_MAX_LENGTH = 20;
export const USER_NAME_MAX_LENGTH = 20;

export const ORGANIZATION_NAME_HINT = `${ORGANIZATION_NAME_MAX_LENGTH} caractères maximum.`;
export const USER_NAME_HINT = `${USER_NAME_MAX_LENGTH} caractères maximum.`;
