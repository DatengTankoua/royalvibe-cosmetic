import {
  DelegablePermission,
  OrganizationRole,
  effectivePermissions,
} from '../../organizations/permissions';

/**
 * 1-16A / 1-16A.1 — Catégories de notifications métier (aucune autre : ni
 * campagne marketing, ni notification par modification de vente).
 * - `stock-depleted` : passage réel d'un stock positif à zéro ;
 * - `stock-low` (1-16A.1) : franchissement de 80 % du stock initial consommé ;
 * - `sale-created` (1-16A.1) : vente réellement validée (création seule) ;
 * - `subscription-ending` : échéance UTC effective dans moins de 24 heures ;
 * - `payment-succeeded` : période attribuée et paiement `succeeded` ;
 * - `monthly-report` (1-16A.1) : bilan du mois civil écoulé disponible ;
 * - `member-joined` (1-19A) : adhésion réussie après acceptation d'une
 *   invitation ;
 * - `member-activity` (1-19A) : action d'écriture réussie d'un autre membre,
 *   regroupée par auteur, action et fenêtre d'une minute (propriétaire seul).
 */
export enum PushCategory {
  STOCK_DEPLETED = 'stock-depleted',
  STOCK_LOW = 'stock-low',
  SALE_CREATED = 'sale-created',
  SUBSCRIPTION_ENDING = 'subscription-ending',
  PAYMENT_SUCCEEDED = 'payment-succeeded',
  MONTHLY_REPORT = 'monthly-report',
  MEMBER_JOINED = 'member-joined',
  MEMBER_ACTIVITY = 'member-activity',
  /**
   * 1-16A.1 — INTERNE, push seulement : regroupement des ventes d'une
   * organisation sur une fenêtre fixe d'une minute (jamais une notification
   * du centre, jamais une préférence).
   */
  SALE_DIGEST = 'sale-digest',
}

/** Catégories visibles (centre, préférences, appareils). */
export const PUSH_CATEGORIES: readonly PushCategory[] = Object.freeze([
  PushCategory.STOCK_DEPLETED,
  PushCategory.STOCK_LOW,
  PushCategory.SALE_CREATED,
  PushCategory.SUBSCRIPTION_ENDING,
  PushCategory.PAYMENT_SUCCEEDED,
  PushCategory.MONTHLY_REPORT,
  PushCategory.MEMBER_JOINED,
  PushCategory.MEMBER_ACTIVITY,
]);

/** Préférences push par appareil ; toutes actives à l'activation. */
export interface PushPreferences {
  stockDepleted: boolean;
  stockLow: boolean;
  saleCreated: boolean;
  subscriptionEnding: boolean;
  paymentSucceeded: boolean;
  monthlyReport: boolean;
  /** 1-19A : absentes des préférences déjà enregistrées → actives. */
  memberJoined: boolean;
  memberActivity: boolean;
}

export const DEFAULT_PUSH_PREFERENCES: Readonly<PushPreferences> =
  Object.freeze({
    stockDepleted: true,
    stockLow: true,
    saleCreated: true,
    subscriptionEnding: true,
    paymentSucceeded: true,
    monthlyReport: true,
    memberJoined: true,
    memberActivity: true,
  });

export const PREFERENCE_BY_CATEGORY: Readonly<
  Record<PushCategory, keyof PushPreferences>
> = Object.freeze({
  [PushCategory.STOCK_DEPLETED]: 'stockDepleted',
  [PushCategory.STOCK_LOW]: 'stockLow',
  [PushCategory.SALE_CREATED]: 'saleCreated',
  [PushCategory.SUBSCRIPTION_ENDING]: 'subscriptionEnding',
  [PushCategory.PAYMENT_SUCCEEDED]: 'paymentSucceeded',
  [PushCategory.MONTHLY_REPORT]: 'monthlyReport',
  [PushCategory.MEMBER_JOINED]: 'memberJoined',
  [PushCategory.MEMBER_ACTIVITY]: 'memberActivity',
  // Le regroupement suit la préférence « nouvelle vente ».
  [PushCategory.SALE_DIGEST]: 'saleCreated',
});

/** Contexte de droits (membership relue en base ou contexte serveur). */
export interface CategoryAccessContext {
  role: OrganizationRole;
  permissions: readonly DelegablePermission[];
}

/**
 * 1-16A.1 — Règle UNIQUE de visibilité d'une catégorie, appliquée à la
 * répartition, à chaque envoi push ET à chaque lecture du centre (liste,
 * compteur, détail) avec les droits ACTUELS :
 * - stock : `products.view_stock_details` (stock restant et initial) ;
 * - vente (1-19A) : `sales.notifications` (réception), jamais déduite de
 *   `sales.record` ; montant et quantité exigent en plus `sales.view_all`
 *   (détail du centre) ;
 * - échéance, paiement : propriétaire réel (`billing.*` owner-only) ;
 * - bilan : `analytics.read` ;
 * - nouveau membre (1-19A) : `members.manage` (droit de la section Membres) ;
 * - activité des membres (1-19A) : propriétaire réel seulement.
 * Jamais d'élargissement : une permission retirée masque aussitôt les
 * notifications déjà créées.
 */
export function canAccessCategory(
  category: PushCategory,
  context: CategoryAccessContext,
): boolean {
  const granted = effectivePermissions(context.role, [...context.permissions]);
  switch (category) {
    case PushCategory.STOCK_DEPLETED:
    case PushCategory.STOCK_LOW:
      return granted.has('products.view_stock_details');
    case PushCategory.SALE_CREATED:
    case PushCategory.SALE_DIGEST:
      return granted.has('sales.notifications');
    case PushCategory.SUBSCRIPTION_ENDING:
    case PushCategory.PAYMENT_SUCCEEDED:
    case PushCategory.MEMBER_ACTIVITY:
      return context.role === OrganizationRole.OWNER;
    case PushCategory.MONTHLY_REPORT:
      return granted.has('analytics.read');
    case PushCategory.MEMBER_JOINED:
      return granted.has('members.manage');
  }
}

export function accessibleCategories(
  context: CategoryAccessContext,
): PushCategory[] {
  return PUSH_CATEGORIES.filter((c) => canAccessCategory(c, context));
}
