import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "RoyalVibe Cosmétiques & Bijoux",
    short_name: "RoyalVibe",
    description:
      "Application de gestion des ventes RoyalVibe Cosmétiques & Bijoux",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#b8960c",
    categories: ["business", "shopping"],
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/logo.jpg",
        sizes: "any",
        type: "image/jpeg",
      },
    ],
  };
}
