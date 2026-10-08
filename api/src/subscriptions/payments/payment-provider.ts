/**
 * 1-14D.2B — Contrat MINIMAL d'un prestataire de paiement (Mobile Money).
 *
 * Injecté par le jeton `PAYMENT_PROVIDER`. En production, le fournisseur
 * par défaut est `UnavailablePaymentProvider` : aucune initiation ni
 * consultation externe possible (503 `PAYMENT_SERVICE_UNAVAILABLE`), aucun
 * appel réseau. Le simulateur n'existe que dans les tests (`test/e2e`),
 * injecté par `overrideProvider` ; aucune variable d'environnement, route,
 * corps ni en-tête ne peut sélectionner un mode simulé.
 *
 * Exigences pour tout futur adaptateur (ex. CamPay) — à VÉRIFIER, jamais
 * présumées :
 * - `initiate` : lever `PaymentProviderUnavailableError` UNIQUEMENT si la
 *   requête n'a certainement pas atteint le prestataire (aucune collecte
 *   possible) ; toute autre incertitude (timeout, réponse perdue, 5xx après
 *   envoi) → `PaymentProviderUncertainError`.
 * - `supportsMerchantReferenceLookup` : `true` seulement si le prestataire
 *   permet de retrouver une transaction par NOTRE référence marchand
 *   (nécessaire pour lever une initiation incertaine).
 * - `idempotentInitiation` : `true` seulement si une seconde initiation avec
 *   la même référence marchand est GARANTIE sans seconde collecte. Ce lot ne
 *   relance jamais une initiation, même si `true`.
 * - Statut : renvoyer les valeurs BRUTES du prestataire (montant, devise,
 *   références) ; la concordance est vérifiée par le serveur. Ne jamais
 *   journaliser le téléphone, un jeton, un secret ni la réponse brute.
 */

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export const PAYMENT_CURRENCY = 'XAF';

export interface PaymentCollectionRequest {
  /** Référence marchand immuable (`external_reference`). */
  merchantReference: string;
  /** Montant TOTAL figé (XAF, entier). */
  amount: number;
  currency: typeof PAYMENT_CURRENCY;
  /** Téléphone normalisé (`237XXXXXXXXX`) — transitoire, jamais stocké. */
  payerPhone: string;
  description: string;
}

export type PaymentInitiationResult =
  /** Collecte créée chez le prestataire (invite envoyée au payeur). */
  | { outcome: 'accepted'; providerReference: string }
  /** Refus DÉFINITIF avant toute collecte (numéro refusé, opérateur…). */
  | { outcome: 'rejected' };

export type PaymentStatusLookup =
  | { by: 'provider'; providerReference: string }
  | { by: 'merchant'; merchantReference: string };

export type ProviderPaymentState = 'pending' | 'succeeded' | 'failed';

/** Statut BRUT renvoyé par le prestataire (jamais cru sans vérification). */
export interface ProviderPaymentStatus {
  state: ProviderPaymentState;
  providerReference: string;
  merchantReference: string | null;
  amount: unknown;
  currency: unknown;
}

export interface PaymentProvider {
  /** Identifiant stable stocké dans `subscription_payments.provider`. */
  readonly name: string;
  /** `false` : aucune initiation ni consultation (503, aucun réseau). */
  readonly available: boolean;
  readonly supportsMerchantReferenceLookup: boolean;
  readonly idempotentInitiation: boolean;
  initiate(request: PaymentCollectionRequest): Promise<PaymentInitiationResult>;
  /**
   * `null` : transaction introuvable (recherche par référence marchand).
   * Toute erreur = statut indisponible (aucun changement d'état).
   */
  fetchStatus(
    lookup: PaymentStatusLookup,
  ): Promise<ProviderPaymentStatus | null>;
}

/** La requête n'a CERTAINEMENT pas atteint le prestataire. */
export class PaymentProviderUnavailableError extends Error {
  constructor() {
    super('Prestataire de paiement indisponible.');
    this.name = 'PaymentProviderUnavailableError';
  }
}

/** Résultat inconnu : la collecte a PEUT-ÊTRE été créée. */
export class PaymentProviderUncertainError extends Error {
  constructor() {
    super('Résultat de l’initiation inconnu.');
    this.name = 'PaymentProviderUncertainError';
  }
}

/**
 * Fournisseur par défaut (production tant qu'aucun adaptateur réel n'est
 * branché) : indisponible, sans aucun appel réseau. Ses méthodes ne sont
 * jamais appelées par le service (contrôle `available` préalable) ; elles
 * échouent sans effet par défense en profondeur.
 */
export class UnavailablePaymentProvider implements PaymentProvider {
  readonly name = 'unavailable';
  readonly available = false;
  readonly supportsMerchantReferenceLookup = false;
  readonly idempotentInitiation = false;

  initiate(): Promise<PaymentInitiationResult> {
    return Promise.reject(new PaymentProviderUnavailableError());
  }

  fetchStatus(): Promise<ProviderPaymentStatus | null> {
    return Promise.reject(new PaymentProviderUnavailableError());
  }
}
