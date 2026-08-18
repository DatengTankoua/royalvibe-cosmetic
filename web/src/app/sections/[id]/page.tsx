"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeftIcon, FolderIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { ProductCard } from "@/components/products/product-card";
import { CreateProductDialog } from "@/components/products/create-product-dialog";
import { UpdateProductDialog } from "@/components/products/update-product-dialog";
import { SectionCard } from "@/components/sections/section-card";
import { CreateSectionDialog } from "@/components/sections/create-section-dialog";
import { Input } from "@/components/ui/input";
import {
  fetchSection,
  fetchSections,
  createSection,
  updateSection,
  deleteSection,
  getApiErrorMessage,
  type ApiSection,
  type ApiProduct,
} from "@/lib/api";
import { useProducts } from "@/hooks/use-products";
import { useAuth } from "@/contexts/auth-context";

type ContentMode = "loading" | "subsections" | "products" | "empty";

export default function SectionPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();
  const [section, setSection] = useState<ApiSection | null>(null);
  const [subSections, setSubSections] = useState<ApiSection[]>([]);
  const [subSectionsLoading, setSubSectionsLoading] = useState(true);
  const [editTarget, setEditTarget] = useState<ApiProduct | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [query, setQuery] = useState("");

  const {
    products,
    isLoading: productsLoading,
    error,
    addProduct,
    editProduct,
    removeProduct,
  } = useProducts(params.id);

  const loadSubSections = useCallback(async () => {
    setSubSectionsLoading(true);
    try {
      const data = await fetchSections(params.id);
      setSubSections(data);
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSubSectionsLoading(false);
    }
  }, [params.id]);

  const isLoading = subSectionsLoading || productsLoading;

  const mode: ContentMode = isLoading
    ? "loading"
    : subSections.length > 0
      ? "subsections"
      : products.length > 0
        ? "products"
        : "empty";

  const filtered = useMemo(
    () =>
      query.trim()
        ? products.filter((p) =>
            p.name.toLowerCase().includes(query.toLowerCase()),
          )
        : products,
    [products, query],
  );

  const filteredSubSections = useMemo(
    () =>
      query.trim()
        ? subSections.filter((s) =>
            s.name.toLowerCase().includes(query.toLowerCase()),
          )
        : subSections,
    [subSections, query],
  );

  useEffect(() => {
    if (!authLoading && !user) router.push("/auth/login");
  }, [user, authLoading, router]);

  useEffect(() => {
    fetchSection(params.id)
      .then(setSection)
      .catch((err: unknown) => toast.error(getApiErrorMessage(err)));
  }, [params.id]);

  useEffect(() => {
    void loadSubSections();
  }, [loadSubSections]);

  if (authLoading || !user) return null;

  const backHref = section?.parentId ? `/sections/${section.parentId}` : "/";
  const backLabel = section?.parentId ? "Catalogue parent" : "Catalogue";

  const handleDeleteProduct = async (id: string) => {
    try {
      await removeProduct(id);
      toast.success("Produit supprimé");
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err));
    }
  };

  const handleEditProduct = (product: ApiProduct) => {
    setEditTarget(product);
    setEditOpen(true);
  };

  const handleDeleteSubSection = async (id: string) => {
    try {
      await deleteSection(id);
      setSubSections((prev) => prev.filter((s) => s._id !== id));
      toast.success("Sous-catalogue supprimé");
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err));
    }
  };

  const handleRenameSubSection = async (
    id: string,
    name: string,
    description: string,
  ) => {
    const updated = await updateSection(id, { name, description });
    setSubSections((prev) => prev.map((s) => (s._id === id ? updated : s)));
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
        <Link
          href={backHref}
          className="inline-flex shrink-0 items-center gap-1 self-start rounded-md px-2.5 py-1 text-sm hover:bg-muted transition-colors"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          {backLabel}
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
          <div className="flex shrink-0 gap-2">
            {(mode === "subsections" || mode === "empty") && (
              <CreateSectionDialog
                label="Nouveau sous-catalogue"
                onCreated={async (name, description) => {
                  const s = await createSection({
                    name,
                    description,
                    parentId: params.id,
                  });
                  setSubSections((prev) => [s, ...prev]);
                }}
              />
            )}
            {(mode === "products" || mode === "empty") && (
              <CreateProductDialog
                sectionId={params.id}
                onCreated={async (payload) => {
                  await addProduct(payload);
                }}
              />
            )}
          </div>
        )}
      </div>

      {/* Search bar — only show when there's content */}
      {!isLoading && (subSections.length > 0 || products.length > 0) && (
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={
              mode === "subsections"
                ? "Rechercher un sous-catalogue…"
                : "Rechercher un produit…"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {isLoading && (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      )}
      {!isLoading && error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {/* Sub-sections view */}
      {!isLoading && mode === "subsections" && (
        <>
          {filteredSubSections.length === 0 && query.trim() ? (
            <p className="text-sm text-muted-foreground">
              Aucun résultat pour « {query} ».
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filteredSubSections.map((s) => (
                <SectionCard
                  key={s._id}
                  section={s}
                  isAdmin={user.role === "admin"}
                  onDelete={handleDeleteSubSection}
                  onRename={handleRenameSubSection}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Products view */}
      {!isLoading && mode === "products" && (
        <>
          {products.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucun produit dans cette section.
            </p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucun résultat pour « {query} ».
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filtered.map((p, i) => (
                <ProductCard
                  key={p._id}
                  product={p}
                  isAdmin={user.role === "admin"}
                  priority={i === 0}
                  onDelete={handleDeleteProduct}
                  onEdit={handleEditProduct}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Empty state */}
      {!isLoading && mode === "empty" && (
        <div className="flex flex-col items-center gap-4 py-16 text-center text-muted-foreground">
          <FolderIcon className="h-10 w-10 opacity-30" />
          <p className="text-sm">Ce catalogue est vide.</p>
          {user.role === "admin" && (
            <p className="text-xs">
              Utilise les boutons ci-dessus pour créer un sous-catalogue ou
              ajouter un produit.
            </p>
          )}
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
