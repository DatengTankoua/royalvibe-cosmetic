// Classes des contrôles d'en-tête publics (thème, langue), partagées par
// les en-têtes serveur et client : module neutre, sans dépendance.
// 1-16G : sélecteur de langue avant le thème, même zone de clic.
export const PUBLIC_LANGUAGE_SWITCHER_CLASS =
  "inline-flex h-11 items-center justify-center gap-1 rounded-lg px-2 text-(--brand-ink) hover:bg-(--brand-ink)/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-ink) [&_svg]:size-5";
export const PUBLIC_THEME_TOGGLE_CLASS =
  "inline-flex size-11 items-center justify-center rounded-lg text-(--brand-ink) hover:bg-(--brand-ink)/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-ink) [&_svg]:size-5";
