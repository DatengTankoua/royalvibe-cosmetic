import { redirect } from "next/navigation";

// Alias legacy (1-9D) : les analyses vivent désormais sous `/app/analytics`
// (seule implémentation) — jamais de duplication.
export default function LegacyAnalyticsRedirect() {
  redirect("/app/analytics");
}
