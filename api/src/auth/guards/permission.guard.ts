/**
 * 1-7A — Garde de permissions organisationnelles.
 *
 * Contrat :
 * - Lit UNIQUEMENT `request.organizationContext` (branché par
 *   `OrganizationGuard`, 1-3B.2) ; aucune requête DB, aucun accès à
 *   `User.role`, au JWT, ni à `body`/`query`/`params`/`headers`.
 * - Permissions effectives = `DEFAULT_PERMISSIONS_BY_ROLE[role] ∪
 *   context.permissions`.
 * - `@OwnerOnly` exige `role === owner` STRICTEMENT : jamais vérifiée via
 *   `context.permissions` (ces opérations ne sont AUCUNE permission
 *   délégable — cf. 1-1A — même si une valeur y était injectée).
 * - Aucune métadonnée (`@RequirePermissions`/`@OwnerOnly`) sur la route :
 *   laisse passer sans lire le contexte.
 * - Refus toujours 403 uniforme `{ code: 'PERMISSION_DENIED', message }`,
 *   y compris quand le contexte est absent (jamais 500).
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  OWNER_ONLY_KEY,
  PERMISSIONS_KEY,
} from '../decorators/permissions.decorator';
import { ResolvedOrganizationContext } from '../../organizations/organizations.service';
import {
  DEFAULT_PERMISSIONS_BY_ROLE,
  DelegablePermission,
  OrganizationRole,
  OwnerOnlyOperation,
} from '../../organizations/permissions';

type PermissionGuardRequest = Request & {
  organizationContext?: ResolvedOrganizationContext;
};

// Retour `never` : permet à TypeScript de rétrécir `orgContext` (défini)
// dans le code qui suit son appel conditionnel, sans cast supplémentaire.
function denyPermission(): never {
  throw new ForbiddenException({
    code: 'PERMISSION_DENIED',
    message: 'Permission insuffisante.',
  });
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Non-HTTP (Socket.IO) : géré par son propre middleware d'auth (0B.3).
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requiredPermissions = this.reflector.getAllAndOverride<
      DelegablePermission[] | undefined
    >(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);
    const ownerOnlyOperation = this.reflector.getAllAndOverride<
      OwnerOnlyOperation | undefined
    >(OWNER_ONLY_KEY, [context.getHandler(), context.getClass()]);

    const hasPermissionMetadata =
      !!requiredPermissions && requiredPermissions.length > 0;
    if (!hasPermissionMetadata && !ownerOnlyOperation) return true;

    const request = context.switchToHttp().getRequest<PermissionGuardRequest>();
    const orgContext = request.organizationContext;
    if (!orgContext) denyPermission();

    if (ownerOnlyOperation && orgContext.role !== OrganizationRole.OWNER) {
      denyPermission();
    }

    if (hasPermissionMetadata) {
      const effective = new Set<DelegablePermission>([
        ...DEFAULT_PERMISSIONS_BY_ROLE[orgContext.role],
        ...orgContext.permissions,
      ]);
      const hasAll = requiredPermissions.every((p) => effective.has(p));
      if (!hasAll) denyPermission();
    }

    return true;
  }
}
