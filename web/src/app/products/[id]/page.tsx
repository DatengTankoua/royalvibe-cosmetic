import { redirect } from "next/navigation";

// Alias legacy (1-9D) : la fiche produit vit désormais sous
// `/app/catalog/products/[id]` (seule implémentation) — jamais de duplication.
export default async function LegacyProductRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/app/catalog/products/${id}`);
}
