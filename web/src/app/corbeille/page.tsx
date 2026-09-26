import { redirect } from "next/navigation";

// Alias legacy (1-9D) : la corbeille vit désormais sous `/app/trash` (seule
// implémentation) — jamais de duplication.
export default function LegacyTrashRedirect() {
  redirect("/app/trash");
}
