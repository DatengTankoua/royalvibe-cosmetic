import type { TransformFnParams } from 'class-transformer';

/**
 * Limites de noms (1-12C), communes à TOUS les chemins d'écriture :
 * `POST /auth/register`, `POST /auth/invitations/accept`,
 * `PATCH /organizations/current/branding`. Comptées après trim, en unités
 * `String.length` (mêmes unités que l'attribut HTML `maxLength` côté web).
 * Unicode et accents autorisés ; aucune troncature silencieuse : un
 * dépassement est un 400.
 */
export const ORGANIZATION_NAME_MAX_LENGTH = 60;
export const USER_NAME_MAX_LENGTH = 80;

export const ORGANIZATION_NAME_MESSAGE = `Le nom de l'organisation doit contenir entre 1 et ${ORGANIZATION_NAME_MAX_LENGTH} caractères.`;
export const USER_NAME_MESSAGE = `Le nom doit contenir entre 1 et ${USER_NAME_MAX_LENGTH} caractères.`;

/**
 * Trim AVANT validation (`@Transform`, `ValidationPipe({ transform: true })`
 * global) : la valeur trimée est aussi celle persistée. Une valeur non
 * chaîne est laissée telle quelle pour que `@IsString` la refuse.
 */
export function trimString({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}
