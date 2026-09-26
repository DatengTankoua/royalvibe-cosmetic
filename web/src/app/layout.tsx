import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/contexts/auth-context";
import { Navbar } from "@/components/layout/navbar";
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
  // Aucune icône Stock Master officielle (1-9B) : pas d'icône invoquée
  // plutôt que réutiliser l'ancien visuel RoyalVibe.
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
          <Navbar />
          <main className="flex-1 flex flex-col pb-16 md:pb-0">{children}</main>
          <Toaster />
        </AuthProvider>
        <PwaRegister />
      </body>
    </html>
  );
}
