import type { Metadata } from "next";
import { getServerT } from "@/i18n/server";

// 1-13B : le lien porte un token en query string. Rendu dynamique (jamais
// prérendu ni mis en cache partagé), aucun référent, page non indexée.
export const dynamic = "force-dynamic";

// 1-16G : titre dans la langue de la requête.
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerT("auth");
  return {
    title: `${t("reset.title")} – Stock Master`,
    referrer: "no-referrer",
    robots: { index: false, follow: false },
  };
}

export default function ResetPasswordLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
