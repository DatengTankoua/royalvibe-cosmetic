import path from "node:path";
import type { NextConfig } from "next";

// Standalone uniquement pour l'image Docker (DOCKER_BUILD=true, défini dans le
// stage de build de web/Dockerfile) ; les builds Vercel restent inchangés.
// La racine de traçage est celle du workspace pnpm (lockfile racine).
const isDockerBuild = process.env.DOCKER_BUILD === "true";

const nextConfig: NextConfig = {
  ...(isDockerBuild
    ? {
        output: "standalone" as const,
        outputFileTracingRoot: path.join(__dirname, ".."),
      }
    : {}),
  // 1-13A : page de confirmation d'email (token en query string) — aucun
  // référent transmis, aucun stockage en cache.
  async headers() {
    return [
      {
        source: "/auth/verify-email",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex" },
        ],
      },
    ];
  },
  images: {
    remotePatterns: [
      { protocol: "http", hostname: "localhost", port: "9000" },
      { protocol: "https", hostname: process.env.S3_HOSTNAME ?? "localhost" },
    ],
  },
};

export default nextConfig;
