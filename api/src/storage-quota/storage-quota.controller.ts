import { Controller, ForbiddenException, Get } from '@nestjs/common';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import {
  hasPermission,
  PERMISSION_DENIED_RESPONSE,
  type DelegablePermission,
} from '../organizations/permissions';
import { StorageQuotaService } from './storage-quota.service';

/**
 * Permissions qui créent ou libèrent des fichiers : l'une d'elles suffit
 * pour consulter l'occupation (photos, logo, purge de la corbeille).
 */
export const STORAGE_USAGE_PERMISSIONS: readonly DelegablePermission[] = [
  'products.manage',
  'branding.manage',
  'trash.manage',
];

/**
 * 1-17B — Occupation du stockage de l'organisation COURANTE (contexte
 * branché par `OrganizationGuard`, jamais un identifiant client). Lecture
 * seule : aucune route ne modifie le quota. Jamais de clé ni d'URL.
 */
@Controller('organizations/current/storage')
export class StorageQuotaController {
  constructor(private readonly storageQuota: StorageQuotaService) {}

  @Get()
  getUsage(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    if (
      !STORAGE_USAGE_PERMISSIONS.some((p) =>
        hasPermission(organizationContext, p),
      )
    ) {
      throw new ForbiddenException(PERMISSION_DENIED_RESPONSE);
    }
    return this.storageQuota.usage(organizationContext.organizationId);
  }
}
