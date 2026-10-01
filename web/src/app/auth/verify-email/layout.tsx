import type { Metadata } from "next";

// 1-13A : le lien porte un token en query string. Rendu dynamique → Next
// répond `Cache-Control: private, no-cache, no-store` (jamais de cache
// partagé du document) ; aucun référent transmis, page non indexée.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Confirmer mon adresse email – Stock Master",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function VerifyEmailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
