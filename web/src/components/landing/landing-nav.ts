// 1-16B — Ancres de l'accueil public, partagées par l'en-tête (composant
// client) et le pied de page (composant serveur). Module neutre : une
// constante exportée d'un module "use client" n'est, côté serveur, qu'une
// référence client (pas un tableau).
// 1-16G : libellés dans `public` (`nav.*`).
export const LANDING_NAV = [
  { href: "#fonctionnalites", key: "features" },
  { href: "#hors-ligne", key: "offline" },
  { href: "#tarifs", key: "pricing" },
  { href: "#questions", key: "faq" },
] as const;
