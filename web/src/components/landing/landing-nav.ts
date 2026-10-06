// 1-16B — Ancres de l'accueil public, partagées par l'en-tête (composant
// client) et le pied de page (composant serveur). Module neutre : une
// constante exportée d'un module "use client" n'est, côté serveur, qu'une
// référence client (pas un tableau).
export const LANDING_NAV = [
  { href: "#fonctionnalites", label: "Fonctionnalités" },
  { href: "#hors-ligne", label: "Sans réseau" },
  { href: "#tarifs", label: "Tarifs" },
  { href: "#questions", label: "Questions" },
] as const;
