import { redirect } from "next/navigation";

// Alias legacy (QR/liens imprimés historiques vers `/objects/:id`) : redirige
// directement vers la fiche produit sous le shell, sans repasser par l'ancien
// alias `/products/:id` (1-9D).
export default async function LegacyObjectRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/app/catalog/products/${id}`);
}
