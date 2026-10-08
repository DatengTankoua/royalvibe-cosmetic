import { redirect } from "next/navigation";

// Alias legacy (1-9D) : la page catalogue vit désormais sous
// `/app/catalog/[id]` (seule implémentation) — jamais de duplication.
export default async function LegacySectionRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/app/catalog/${id}`);
}
