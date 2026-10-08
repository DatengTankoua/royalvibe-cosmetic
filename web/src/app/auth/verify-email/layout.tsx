import type { Metadata } from "next";
import { getServerT } from "@/i18n/server";

// 1-13A : le lien porte un token en query string. Rendu dynamique → Next
// répond `Cache-Control: private, no-cache, no-store` (jamais de cache
// partagé du document) ; aucun référent transmis, page non indexée.
export const dynamic = "force-dynamic";

// 1-16G : titre dans la langue de la requête.
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerT("auth");
  return {
    title: `${t("verify.metaTitle")} – Stock Master`,
    referrer: "no-referrer",
    robots: { index: false, follow: false },
  };
}

export default function VerifyEmailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
