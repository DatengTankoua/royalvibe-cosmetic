import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // output: "standalone" — uniquement pour Docker, pas Vercel
  images: {
    remotePatterns: [
      { protocol: "http", hostname: "localhost", port: "9000" },
      { protocol: "https", hostname: process.env.S3_HOSTNAME ?? "localhost" },
    ],
  },
};

export default nextConfig;
