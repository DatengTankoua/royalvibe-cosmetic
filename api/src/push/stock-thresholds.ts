/**
 * 1-16A.1 — Seuil « stock presque épuisé » : 80 % du stock initial consommé,
 * avec `consommé = initialQuantity − remainingQuantity` (modèle actuel).
 *
 * Comparaison EXACTE `5 × consommé ≥ 4 × initial` (aucun pourcentage
 * d'affichage arrondi ni division flottante) : 100 initiales → atteint à
 * 20 restantes, pas à 21. Quantité initiale nulle, négative ou non finie :
 * jamais atteint (aucune alerte).
 */
export function stockLowReached(
  initialQuantity: number,
  remainingQuantity: number,
): boolean {
  if (
    !Number.isFinite(initialQuantity) ||
    !Number.isFinite(remainingQuantity) ||
    initialQuantity <= 0
  ) {
    return false;
  }
  const consumed = initialQuantity - remainingQuantity;
  return 5 * consumed >= 4 * initialQuantity;
}

/**
 * Franchissement par UNE écriture (valeurs avant / après de la même
 * opération atomique) : non atteint avant, atteint après. Repasser sous le
 * seuil (réapprovisionnement, correction, annulation) réarme naturellement
 * le franchissement suivant.
 */
export function stockLowCrossed(
  initialBefore: number,
  remainingBefore: number,
  initialAfter: number,
  remainingAfter: number,
): boolean {
  return (
    !stockLowReached(initialBefore, remainingBefore) &&
    stockLowReached(initialAfter, remainingAfter)
  );
}
