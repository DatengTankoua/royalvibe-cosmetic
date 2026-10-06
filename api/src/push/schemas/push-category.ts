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
 * - `monthly-report` (1-16A.1) : bilan du mois civil écoulé disponible.
 */
export enum PushCategory {
  STOCK_DEPLETED = 'stock-depleted',
  STOCK_LOW = 'stock-low',
  SALE_CREATED = 'sale-created',
  SUBSCRIPTION_ENDING = 'subscription-ending',
  PAYMENT_SUCCEEDED = 'payment-succeeded',
  MONTHLY_REPORT = 'monthly-report',
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
]);

/** Préférences push par appareil ; toutes actives à l'activation. */
export interface PushPreferences {
  stockDepleted: boolean;
  stockLow: boolean;
  saleCreated: boolean;
  subscriptionEnding: boolean;
  paymentSucceeded: boolean;
  monthlyReport: boolean;
}

export const DEFAULT_PUSH_PREFERENCES: Readonly<PushPreferences> =
  Object.freeze({
    stockDepleted: true,
    stockLow: true,
    saleCreated: true,
    subscriptionEnding: true,
    paymentSucceeded: true,
    monthlyReport: true,
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
 * - vente : propriétaire ou administrateur avec `sales.view_all` ;
 * - échéance, paiement : propriétaire réel (`billing.*` owner-only) ;
 * - bilan : `analytics.read`.
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
      return (
        (context.role === OrganizationRole.OWNER ||
          context.role === OrganizationRole.ADMIN) &&
        granted.has('sales.view_all')
      );
    case PushCategory.SUBSCRIPTION_ENDING:
    case PushCategory.PAYMENT_SUCCEEDED:
      return context.role === OrganizationRole.OWNER;
    case PushCategory.MONTHLY_REPORT:
      return granted.has('analytics.read');
  }
}

export function accessibleCategories(
  context: CategoryAccessContext,
): PushCategory[] {
  return PUSH_CATEGORIES.filter((c) => canAccessCategory(c, context));
}
