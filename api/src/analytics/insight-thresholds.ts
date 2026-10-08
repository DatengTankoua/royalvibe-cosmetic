/**
 * 1-16E — seuils de l'aide à la décision (page Analyse).
 *
 * Ce sont des CHOIX DU PRODUIT, pas des vérités statistiques : ils sont
 * réunis ici pour être ajustés après usage, sans toucher aux calculs.
 * Aucun ne modifie les notifications existantes (seuil 80 % de 1-16A.1,
 * `push/stock-thresholds.ts`, inchangé et réutilisé tel quel).
 *
 * - `observationWindowDays` : jours civils TERMINÉS observés (aujourd'hui
 *   exclu) pour le rythme des ventes et les produits sans vente récente ;
 * - `minObservationDays` / `minDistinctSaleDays` : en dessous, aucune
 *   estimation (« Pas assez de ventes pour estimer ») ;
 * - `soonStockoutDays` : jours estimés restants (valeur NON arrondie) en
 *   dessous desquels un produit est mis en évidence ;
 * - `maxPriorities` : cartes « À surveiller » affichées au plus ;
 * - `topProducts` : produits de « Ce qui se vend » ;
 * - `listLimit` : éléments renvoyés par liste (les décomptes portent
 *   toujours sur TOUS les produits concernés).
 */
export const INSIGHT_THRESHOLDS = Object.freeze({
  observationWindowDays: 28,
  minObservationDays: 14,
  minDistinctSaleDays: 3,
  soonStockoutDays: 7,
  maxPriorities: 3,
  topProducts: 5,
  listLimit: 50,
});

export type InsightThresholds = typeof INSIGHT_THRESHOLDS;
