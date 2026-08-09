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
  title: "RoyalVibe Cosmétiques & Bijoux",
  description:
    "Application de gestion des ventes — Cosmétiques, Parfums & Joaillerie",
  applicationName: "RoyalVibe",
  appleWebApp: {
    capable: true,
    title: "RoyalVibe",
    statusBarStyle: "default",
  },
  icons: {
    icon: "/logo.jpg",
    apple: "/logo.jpg",
  },
  openGraph: {
    title: "RoyalVibe Cosmétiques & Bijoux",
    description:
      "Application de gestion des ventes — Cosmétiques, Parfums & Joaillerie",
    images: ["/logo.jpg"],
  },
};

export const viewport: Viewport = {
  themeColor: "#b8960c",
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
          <main className="flex-1 flex flex-col">{children}</main>
          <Toaster />
        </AuthProvider>
        <PwaRegister />
      </body>
    </html>
  );
}
