import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { ResolvedOrganizationContext } from '../../organizations/organizations.service';

/**
 * Factory du décorateur : lecture seule du contexte branché par
 * `OrganizationGuard` (1-3B.2). Pas de re-lookup DB, pas de claim client.
 * Exportée pour le spec unitaire (test direct de la logique, sans
 * construire un vrai param decorator).
 */
export function extractOrganizationContext(
  ctx: ExecutionContext,
): ResolvedOrganizationContext {
  const request = ctx
    .switchToHttp()
    .getRequest<
      Request & { organizationContext: ResolvedOrganizationContext }
    >();
  return request.organizationContext;
}

export const CurrentOrganization = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ResolvedOrganizationContext =>
    extractOrganizationContext(ctx),
);
