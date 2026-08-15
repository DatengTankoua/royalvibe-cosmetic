"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeftIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { ProductCard } from "@/components/products/product-card";
import { CreateProductDialog } from "@/components/products/create-product-dialog";
import { UpdateProductDialog } from "@/components/products/update-product-dialog";
import { Input } from "@/components/ui/input";
import {
  fetchSection,
  getApiErrorMessage,
  type ApiSection,
  type ApiProduct,
} from "@/lib/api";
import { useProducts } from "@/hooks/use-products";
import { useAuth } from "@/contexts/auth-context";

export default function SectionPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();
  const [section, setSection] = useState<ApiSection | null>(null);
  const [editTarget, setEditTarget] = useState<ApiProduct | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [query, setQuery] = useState("");

  const { products, isLoading, error, addProduct, editProduct, removeProduct } =
    useProducts(params.id);

  const filtered = useMemo(
    () =>
      query.trim()
        ? products.filter((p) =>
            p.name.toLowerCase().includes(query.toLowerCase()),
          )
        : products,
    [products, query],
  );

  useEffect(() => {
    if (!authLoading && !user) router.push("/auth/login");
  }, [user, authLoading, router]);

  useEffect(() => {
    fetchSection(params.id)
      .then(setSection)
      .catch((err: unknown) => toast.error(getApiErrorMessage(err)));
  }, [params.id]);

  if (authLoading || !user) return null;

  const handleDelete = async (id: string) => {
    try {
      await removeProduct(id);
      toast.success("Produit supprimé");
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err));
    }
  };

  const handleEdit = (product: ApiProduct) => {
    setEditTarget(product);
    setEditOpen(true);
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      {/* Header — responsive: stack on mobile */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
        <Link
          href="/"
          className="inline-flex shrink-0 items-center gap-1 self-start rounded-md px-2.5 py-1 text-sm hover:bg-muted transition-colors"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          Catalogue
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="truncate text-2xl font-semibold">
            {section?.name ?? "…"}
          </h1>
          {section?.description && (
            <p className="text-sm text-muted-foreground">
              {section.description}
            </p>
          )}
        </div>
        {user.role === "admin" && (
          <div className="shrink-0">
            <CreateProductDialog
              sectionId={params.id}
              onCreated={async (payload) => {
                await addProduct(payload);
              }}
            />
          </div>
        )}
      </div>

      {/* Search bar */}
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Rechercher un produit…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      )}
      {!isLoading && error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
      {!isLoading && !error && products.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Aucun produit dans cette section.
        </p>
      )}
      {!isLoading && !error && products.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Aucun résultat pour « {query} ».
        </p>
      )}

      {!isLoading && !error && filtered.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((p, i) => (
            <ProductCard
              key={p._id}
              product={p}
              isAdmin={user.role === "admin"}
              priority={i === 0}
              onDelete={handleDelete}
              onEdit={handleEdit}
            />
          ))}
        </div>
      )}

      <UpdateProductDialog
        product={editTarget}
        open={editOpen}
        onOpenChange={setEditOpen}
        onUpdated={async (id, payload) => {
          await editProduct(id, payload);
        }}
      />
    </div>
  );
}
