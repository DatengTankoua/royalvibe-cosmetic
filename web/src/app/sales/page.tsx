import { redirect } from "next/navigation";

// Alias legacy (1-9D) : la liste des ventes vit désormais sous `/app/sales`
// (seule implémentation) — jamais de duplication.
export default function LegacySalesRedirect() {
  redirect("/app/sales");
}
