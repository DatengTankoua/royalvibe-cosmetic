import type { Metadata } from "next";

// 1-13B : le lien porte un token en query string. Rendu dynamique (jamais
// prérendu ni mis en cache partagé), aucun référent, page non indexée.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Nouveau mot de passe – Stock Master",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function ResetPasswordLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
