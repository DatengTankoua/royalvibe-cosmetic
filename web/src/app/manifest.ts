import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Stock Master",
    short_name: "Stock Master",
    // 1-16G : le manifeste est exclu du mécanisme de langue (fichier
    // unique, mis en cache par le navigateur) : description bilingue.
    description:
      "Gestion des stocks et des ventes · Stock and sales management",
    lang: "fr",
    dir: "ltr",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#FFFFFF",
    theme_color: "#062B5C",
    categories: ["business", "shopping"],
    // Icônes officielles Stock Master (1-11A), générées depuis
    // stock-master-icon.png — voir web/scripts/generate-pwa-icons.ps1.
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
