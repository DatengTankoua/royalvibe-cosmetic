import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Stock Master",
    short_name: "Stock Master",
    description: "Application de gestion des stocks et des ventes",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#062B5C",
    categories: ["business", "shopping"],
    // Aucune icône Stock Master officielle (1-9B) : omise plutôt que de
    // réutiliser l'ancien visuel RoyalVibe.
    icons: [],
  };
}
