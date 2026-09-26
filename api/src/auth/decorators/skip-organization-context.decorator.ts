import { SetMetadata } from '@nestjs/common';

/**
 * Saute UNIQUEMENT la résolution `OrganizationGuard` (aucune organisation
 * "courante" requise) — la route reste authentifiée (JwtAuthGuard) et doit
 * elle-même valider toute organisation ciblée via un appel explicite au
 * service (ex. `resolveActiveContext`). Utilisé quand l'organisation/
 * membership du JWT courant peut être devenue inactive (liste des
 * organisations, switch vers une AUTRE organisation).
 */
export const SKIP_ORGANIZATION_CONTEXT_KEY = 'skipOrganizationContext';
export const SkipOrganizationContext = () =>
  SetMetadata(SKIP_ORGANIZATION_CONTEXT_KEY, true);
