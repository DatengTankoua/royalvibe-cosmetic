/**
 * 1-14B — Horloge serveur injectable des abonnements. Remplacée UNIQUEMENT
 * par les tests (`overrideProvider`) : aucune variable d'environnement, aucun
 * en-tête ni paramètre client ne peut modifier l'heure de référence.
 */
export const SUBSCRIPTION_CLOCK = Symbol('SUBSCRIPTION_CLOCK');

export type SubscriptionClock = () => Date;

export const systemSubscriptionClock: SubscriptionClock = () => new Date();
