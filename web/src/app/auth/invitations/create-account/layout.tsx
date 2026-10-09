import type { Metadata } from "next";
import { getServerT } from "@/i18n/server";

// 1-18B : le lien de création (envoyé à l'adresse invitée) porte un token en
// query string. Rendu dynamique (jamais prérendu ni mis en cache partagé),
// aucun référent, page non indexée.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerT("auth");
  return {
    title: `${t("invitation.create.title")} – Stock Master`,
    referrer: "no-referrer",
    robots: { index: false, follow: false },
  };
}

export default function CreateInvitationAccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
