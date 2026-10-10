// 1-20F — Règle de recherche d'un produit dans la liste d'un rayon, la même
// que celle de la page avant 1-20F et que celle du serveur (`q`) : le nom
// CONTIENT le texte tel que saisi, casse ignorée, accents distingués. Un
// texte fait seulement d'espaces ne filtre rien.

export function isProductSearch(query: string): boolean {
  return query.trim().length > 0;
}

export function matchesProductSearch(name: string, query: string): boolean {
  return (
    !isProductSearch(query) || name.toLowerCase().includes(query.toLowerCase())
  );
}
