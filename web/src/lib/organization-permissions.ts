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
  "analytics.read",
  "audit.read",
  "trash.manage",
  "branding.manage",
  "members.invite",
  "members.manage",
] as const;

export type DelegablePermission = (typeof DELEGABLE_PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<DelegablePermission, string> = {
  "catalog.manage": "Gérer le catalogue",
  "products.manage": "Gérer les produits",
  "stock.adjust": "Ajuster le stock",
  "sales.record": "Enregistrer des ventes",
  "sales.view_own": "Voir ses propres ventes",
  "sales.view_all": "Voir toutes les ventes",
  "analytics.read": "Voir les analyses",
  "audit.read": "Voir l'historique d'audit",
  "trash.manage": "Gérer la corbeille",
  "branding.manage": "Gérer le branding",
  "members.invite": "Inviter des membres",
  "members.manage": "Gérer les membres",
};

export type OrganizationRole = "owner" | "admin" | "seller";

// Rôles attribuables via PATCH /organizations/members/:id — jamais `owner`
// (transfert de propriété dédié : POST .../:id/transfer-ownership).
export const ASSIGNABLE_MEMBER_ROLES = ["admin", "seller"] as const;

// Rôles invitables via POST /organizations/invitations — jamais `owner`.
export const INVITABLE_ROLES = ["admin", "seller"] as const;

export const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: "Propriétaire",
  admin: "Administrateur",
  seller: "Vendeur",
};
