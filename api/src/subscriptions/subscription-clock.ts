/**
 * 1-14B — Horloge serveur injectable des abonnements. Remplacée UNIQUEMENT
 * par les tests (`overrideProvider`) : aucune variable d'environnement, aucun
 * en-tête ni paramètre client ne peut modifier l'heure de référence.
 */
export const SUBSCRIPTION_CLOCK = Symbol('SUBSCRIPTION_CLOCK');

export type SubscriptionClock = () => Date;

export const systemSubscriptionClock: SubscriptionClock = () => new Date();

/**
 * 1-14D.2B — Horloge MONOTONE (millisecondes) des budgets transactionnels :
 * insensible aux ajustements de l'heure système. Remplacée uniquement par
 * les tests ; jamais l'heure métier (`SUBSCRIPTION_CLOCK`).
 */
export const SUBSCRIPTION_MONOTONIC_CLOCK = Symbol(
  'SUBSCRIPTION_MONOTONIC_CLOCK',
);

export type MonotonicClock = () => number;

export const systemMonotonicClock: MonotonicClock = () => performance.now();
