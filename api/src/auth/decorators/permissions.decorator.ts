import { SetMetadata } from '@nestjs/common';
import {
  DelegablePermission,
  OwnerOnlyOperation,
} from '../../organizations/permissions';

/**
 * 1-7A — Métadonnées de permission consommées par `PermissionGuard`.
 * Toutes les permissions listées sont requises (ET, jamais OU).
 */
export const PERMISSIONS_KEY = 'permissions';
export const RequirePermissions = (...permissions: DelegablePermission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * `operation` doit appartenir à `OWNER_ONLY_OPERATIONS` (1-1A) : jamais
 * délégable via `membership.permissions`, contrôlée uniquement par le rôle.
 */
export const OWNER_ONLY_KEY = 'ownerOnlyOperation';
export const OwnerOnly = (operation: OwnerOnlyOperation) =>
  SetMetadata(OWNER_ONLY_KEY, operation);
