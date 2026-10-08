import { createProxy } from "next-i18next/proxy";
import { baseI18nConfig } from "@/i18n/settings";

// 1-16G — Langue de chaque requête de page (URL inchangées). Ordre :
// cookie de préférence `stockmaster.lang`, sinon en-tête Accept-Language du
// navigateur (proposition initiale de l'anglais), sinon français. Le
// résultat est transmis au rendu serveur par un en-tête interne, réécrit à
// chaque requête (une valeur envoyée par le client est remplacée). Le proxy
// ne pose aucun cookie et ne lit aucune session.
export const proxy = createProxy(baseI18nConfig);

// Exclus : fichiers statiques et versionnés, service worker, manifeste,
// icônes et images publiques. Les routes API et sockets sont servies par
// l'API (autre origine) et ne passent jamais ici.
export const config = {
  matcher: [
    "/((?!api|socket\\.io|_next/static|_next/image|sw\\.js|manifest\\.webmanifest|favicon\\.ico|icons/|brand/|marketing/|robots\\.txt|sitemap\\.xml|.*\\.[a-zA-Z0-9]+$).*)",
  ],
};
