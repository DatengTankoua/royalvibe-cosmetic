import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/contexts/auth-context";
import { PwaRegister } from "@/components/layout/pwa-register";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Stock Master",
  description: "Application de gestion des stocks et des ventes",
  applicationName: "Stock Master",
  appleWebApp: {
    capable: true,
    title: "Stock Master",
    statusBarStyle: "default",
  },
  // Icônes officielles Stock Master (1-11A) — générées depuis
  // stock-master-icon.png, jamais l'ancien visuel RoyalVibe.
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      {
        url: "/icons/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  openGraph: {
    title: "Stock Master",
    description: "Application de gestion des stocks et des ventes",
  },
};

export const viewport: Viewport = {
  themeColor: "#062B5C",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="fr"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <AuthProvider>
          <main className="flex-1 flex flex-col">{children}</main>
          <Toaster />
        </AuthProvider>
        <PwaRegister />
      </body>
    </html>
  );
}
