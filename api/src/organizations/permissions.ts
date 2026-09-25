/**
 * Phase 1-1A — socle multi-tenant : rôles, statuts et permissions.
 *
 * Ce module est la source unique des enums/constantes de permissions :
 * les schémas Organization et OrganizationMembership en importent des
 * valeurs (aucune dépendance circulaire). Aucune garde ni fonction
 * d'autorisation n'est créée ici : le calcul de l'autorisation effective
 * (permissions du rôle ∪ permissions supplémentaires) viendra en 1-7.
 */

export enum OrganizationRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  SELLER = 'seller',
}

export enum MembershipStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  REVOKED = 'revoked',
}

export enum OrganizationStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

/** Cycle de vie d'une invitation (1-6B.1) — jamais de suppression physique. */
export enum InvitationStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REVOKED = 'revoked',
  EXPIRED = 'expired',
}

/** Devises initiales. `XAF` (CFA franc, Cameroun) est la valeur par défaut. */
export enum OrganizationCurrency {
  XAF = 'XAF',
  EUR = 'EUR',
}

/**
 * Permissions délégables. La liste est figée par la phase 1-1A ;
 * `membership.permissions` ne représente QUE des valeurs de cette liste
 * (permissions supplémentaires explicitement accordées).
 * Gelée à l'exécution (`Object.freeze`).
 */
export const DELEGABLE_PERMISSIONS = Object.freeze([
  'catalog.manage',
  'products.manage',
  'stock.adjust',
  'sales.record',
  'sales.view_own',
  'sales.view_all',
  'analytics.read',
  'audit.read',
  'trash.manage',
  'branding.manage',
  'members.invite',
  'members.manage',
] as const);

export type DelegablePermission = (typeof DELEGABLE_PERMISSIONS)[number];

/**
 * Référence identique à `DELEGABLE_PERMISSIONS` (pas de copie divergente) :
 * la liste complète des permissions délégables.
 */
export const ALL_DELEGABLE_PERMISSIONS = DELEGABLE_PERMISSIONS;

/**
 * Permissions par défaut de chaque rôle (immuable).
 * `owner` et `admin` reçoivent l'intégralité des permissions délégables ;
 * `seller` ne reçoit que `sales.record` et `sales.view_own`.
 */
export const DEFAULT_PERMISSIONS_BY_ROLE: Readonly<
  Record<OrganizationRole, readonly DelegablePermission[]>
> = Object.freeze({
  [OrganizationRole.OWNER]: Object.freeze([...DELEGABLE_PERMISSIONS]),
  [OrganizationRole.ADMIN]: Object.freeze([...DELEGABLE_PERMISSIONS]),
  [OrganizationRole.SELLER]: Object.freeze([
    'sales.record',
    'sales.view_own',
  ] as const),
});

/**
 * Opérations EXCLUSIVES de l'opérateur `owner` (contrainte 4 du cahier des
 * charges 1A) : elles ne sont AUCUNE permission délégable. Elles seront
 * contrôlées ultérieurement directement par le rôle `owner` (phase 1-7),
 * jamais par `membership.permissions`.
 */
export const OWNER_ONLY_OPERATIONS = Object.freeze([
  'ownership.transfer',
  'organization.delete',
  'billing.identity',
  'owner.attribution',
] as const);

export type OwnerOnlyOperation = (typeof OWNER_ONLY_OPERATIONS)[number];
