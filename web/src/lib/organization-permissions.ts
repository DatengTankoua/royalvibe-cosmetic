// Miroir de `api/src/organizations/permissions.ts` (DELEGABLE_PERMISSIONS) —
// aucun endpoint n'expose ce catalogue complet, seulement les permissions
// accordées/effectives (GET /auth/context). Garder cette liste synchronisée
// avec le backend, jamais inventer de nouvelle permission ici.
export const DELEGABLE_PERMISSIONS = [
  "catalog.manage",
  "products.manage",
  "stock.adjust",
  "sales.record",
  "sales.view_own",
  "sales.view_all",
  "products.view_stock_details",
  "products.view_financials",
  "analytics.read",
  "audit.read",
  "trash.manage",
  "branding.manage",
  "members.invite",
  "members.manage",
  // 1-16C.1 : accordée par défaut au propriétaire et à l'administrateur.
  "support.contact",
] as const;

export type DelegablePermission = (typeof DELEGABLE_PERMISSIONS)[number];

// 1-12H — miroir de STANDARD_MEMBER_PERMISSIONS (backend) : droits de tout
// membre actif, ajoutés par le calcul serveur, jamais proposés ni retirables
// dans les « Permissions supplémentaires ».
export const STANDARD_MEMBER_PERMISSIONS: readonly DelegablePermission[] = [
  "sales.record",
  "sales.view_own",
];

// Cases « Permissions supplémentaires » : délégables hors droits standard.
export const SUPPLEMENTARY_PERMISSIONS: readonly DelegablePermission[] =
  DELEGABLE_PERMISSIONS.filter((p) => !STANDARD_MEMBER_PERMISSIONS.includes(p));

// Retire les droits standard d'une liste stockée (memberships historiques) :
// ils restent accordés par le serveur quoi qu'il arrive.
export function supplementaryOnly(
  permissions: readonly DelegablePermission[],
): DelegablePermission[] {
  return permissions.filter((p) => SUPPLEMENTARY_PERMISSIONS.includes(p));
}

// Structural type (pas d'import d'ApiAuthContext ici, éviterait un cycle
// avec lib/api.ts) : toute décision UI passe par `effectivePermissions`,
// jamais par `User.role`/`ApiUser.role` ni un décodage JWT (1-9D).
export function hasPermission(
  authContext:
    { effectivePermissions: DelegablePermission[] } | null | undefined,
  permission: DelegablePermission,
): boolean {
  return authContext?.effectivePermissions.includes(permission) ?? false;
}

// 1-16G : libellés des permissions et des rôles dans `organization`
// (`permissions.*`, `roles.*`) ; les codes internes ne sont jamais traduits.

export type OrganizationRole = "owner" | "admin" | "seller";

// Rôles attribuables via PATCH /organizations/members/:id — jamais `owner`
// (transfert de propriété dédié : POST .../:id/transfer-ownership).
export const ASSIGNABLE_MEMBER_ROLES = ["admin", "seller"] as const;

// Rôles invitables via POST /organizations/invitations — jamais `owner`.
export const INVITABLE_ROLES = ["admin", "seller"] as const;

// 1-12H — un administrateur reçoit TOUTES les permissions délégables par
// défaut (backend : DEFAULT_PERMISSIONS_BY_ROLE.admin, union non réductible).
// Ses cases supplémentaires sont donc toutes cochées et non modifiables.
export function roleGrantsAllPermissions(role: OrganizationRole): boolean {
  return role === "owner" || role === "admin";
}

export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return value === "owner" || value === "admin" || value === "seller";
}

/**
 * 1-17B — droits qui créent ou libèrent des fichiers : l'un d'eux suffit
 * pour consulter l'occupation du stockage (même liste que l'API).
 */
export const STORAGE_USAGE_PERMISSIONS: readonly DelegablePermission[] = [
  "products.manage",
  "branding.manage",
  "trash.manage",
];
