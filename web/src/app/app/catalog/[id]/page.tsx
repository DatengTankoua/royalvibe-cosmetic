"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
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
import { useOfflineCatalog } from "@/hooks/use-offline-catalog";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { useOfflineSales } from "@/contexts/offline-sales-context";
import { hasPermission } from "@/lib/organization-permissions";
import type { OfflineCatalogSection } from "@/lib/offline-catalog-db";
import { useSocket } from "@/contexts/socket-context";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { SECTION_SIGNALS, readSectionSignal } from "@/hooks/use-sections";
import { createResponseOrder } from "@/lib/refresh-coordinator";

type ContentMode = "loading" | "subsections" | "products" | "empty";

function toOfflineSection(s: ApiSection): OfflineCatalogSection {
  return {
    _id: s._id,
    name: s.name,
    description: s.description,
    parentId: s.parentId ?? null,
  };
}

// /app/catalog/[id] (1-9D, ex "/sections/[id]") : sections → `catalog.manage`,
// produits (créer/soft-delete) → `products.manage`, modifier (prix/stock ou
// nom) → `products.manage` OU `stock.adjust` (le backend arbitre par champ
// réellement touché). Jamais `User.role`.
//
// Hors ligne (1-11B, correction) : cette route N'EST JAMAIS utilisée pour
// lire le catalogue hors ligne (dépendrait d'un document Next indisponible
// sans réseau) — seule `/app/catalog` (OfflineCatalogBrowser) le fait. Cette
// page continue en revanche d'ALIMENTER le cache (scope section) après
// chaque chargement en ligne complet et réussi.
export default function CatalogSectionPage() {
  const params = useParams<{ id: string }>();
  const { authContext } = useOrganizationShell();
  const canManageCatalog = hasPermission(authContext, "catalog.manage");
  const canManageProducts = hasPermission(authContext, "products.manage");
  const canAdjustStock = hasPermission(authContext, "stock.adjust");
  const canEditProduct = canManageProducts || canAdjustStock;

  const [section, setSection] = useState<ApiSection | null>(null);
  // 1-15B : section courante supprimée définitivement par un collègue.
  const [sectionPurged, setSectionPurged] = useState(false);
  const [subSections, setSubSections] = useState<ApiSection[]>([]);
  const [subSectionsLoading, setSubSectionsLoading] = useState(true);
  // 1-15B : ordre des réponses (en-tête, sous-catalogues), début de la
  // dernière lecture réussie (rattrapage), sections purgées jamais réaffichées.
  const sectionOrder = useRef(createResponseOrder());
  const subOrder = useRef(createResponseOrder());
  const purged = useRef(new Set<string>());
  const [sectionLoadedAt, setSectionLoadedAt] = useState<number | undefined>(
    undefined,
  );
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
    reload: reloadProducts,
    loadedAt: productsLoadedAt,
  } = useProducts(params.id);
  // 1-11C.3 : stock serveur rechargé après confirmation d'une vente locale.
  const { syncedVersion } = useOfflineSales();
  useEffect(() => {
    if (syncedVersion > 0) void reloadProducts();
  }, [syncedVersion, reloadProducts]);
  const { writeSectionScope } = useOfflineCatalog();

  const loadSubSections = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) setSubSectionsLoading(true);
      const ticket = subOrder.current.begin();
      try {
        const data = await fetchSections(params.id);
        if (!subOrder.current.accept(ticket)) return;
        setSubSections(data.filter((s) => !purged.current.has(s._id)));
      } catch (err: unknown) {
        if (!options.silent) toast.error(getApiErrorMessage(err));
      } finally {
        if (!options.silent) setSubSectionsLoading(false);
      }
    },
    [params.id],
  );

  // 1-15B : en-tête (nom, description, état corbeille) relu via l'API.
  const loadSection = useCallback(
    async (options: { silent?: boolean } = {}) => {
      const requestedAt = Date.now();
      const ticket = sectionOrder.current.begin();
      try {
        const data = await fetchSection(params.id);
        if (purged.current.has(params.id)) return;
        if (!sectionOrder.current.accept(ticket)) return;
        setSection(data);
        setSectionLoadedAt(requestedAt);
      } catch (err: unknown) {
        if (!options.silent) toast.error(getApiErrorMessage(err));
      }
    },
    [params.id],
  );

  const isLoading = subSectionsLoading || productsLoading;

  // N'écrit qu'après un chargement COMPLET et réussi des deux appels
  // (sous-sections + produits) — remplace intégralement les deux scopes de
  // cette section en une seule transaction (jamais un simple merge).
  useEffect(() => {
    if (!isLoading && !error) {
      writeSectionScope(
        params.id,
        subSections.map(toOfflineSection),
        // 1-12H : informations standard uniquement (allowlist v3).
        products.map((p) => ({
          _id: p._id,
          sectionId: p.sectionId,
          name: p.name,
          salePrice: p.salePrice,
          remainingQuantity: p.remainingQuantity,
          status: p.status,
        })),
      );
    }
  }, [isLoading, error, params.id, subSections, products, writeSectionScope]);

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
    void loadSection();
  }, [loadSection]);

  useEffect(() => {
    void loadSubSections();
  }, [loadSubSections]);

  // 1-15B : signaux de section d'un collègue → en-tête et sous-catalogues
  // relus silencieusement, regroupés, rattrapés à la reconnexion.
  const scheduleRefresh = useLiveRefresh(
    () =>
      Promise.all([
        loadSection({ silent: true }),
        loadSubSections({ silent: true }),
      ]),
    sectionLoadedAt,
  );
  const socket = useSocket();
  const subSectionsRef = useRef(subSections);
  useEffect(() => {
    subSectionsRef.current = subSections;
  });
  useEffect(() => {
    if (!socket) return;
    const handlers = SECTION_SIGNALS.map((event) => {
      const handler = (payload: unknown) => {
        const signal = readSectionSignal(payload);
        if (!signal) return;
        if (event === "section:purged") {
          purged.current.add(signal._id);
          setSubSections((prev) => prev.filter((x) => x._id !== signal._id));
          if (signal._id === params.id) {
            setSectionPurged(true);
            return;
          }
        }
        if (
          signal._id === params.id ||
          signal.parentId === params.id ||
          subSectionsRef.current.some((x) => x._id === signal._id)
        ) {
          scheduleRefresh();
        }
      };
      socket.on(event, handler);
      return [event, handler] as const;
    });
    return () => {
      for (const [event, handler] of handlers) socket.off(event, handler);
    };
  }, [socket, params.id, scheduleRefresh]);

  const backHref = section?.parentId
    ? `/app/catalog/${section.parentId}`
    : "/app/catalog";
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

  // 1-16E : « Ajouter du stock » / « Revoir le prix » depuis l'Analyse
  // (`?modifier=<produit>`) ouvre UNE fois la fenêtre de modification
  // existante, seulement si ce compte peut modifier et que le produit est
  // dans ce catalogue. Le serveur revalide chaque champ modifié.
  const editRequestHandled = useRef(false);
  useEffect(() => {
    if (editRequestHandled.current || productsLoading || !canEditProduct) {
      return;
    }
    const requested = new URLSearchParams(window.location.search).get(
      "modifier",
    );
    if (!requested) return;
    editRequestHandled.current = true;
    const product = products.find((p) => p._id === requested);
    if (product) {
      setEditTarget(product);
      setEditOpen(true);
    }
  }, [products, productsLoading, canEditProduct]);

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
          prefetch={false}
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
        <div className="flex shrink-0 gap-2">
          {canManageCatalog && (mode === "subsections" || mode === "empty") && (
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
          {canManageProducts && (mode === "products" || mode === "empty") && (
            <CreateProductDialog
              sectionId={params.id}
              onCreated={async (payload) => {
                await addProduct(payload);
              }}
            />
          )}
        </div>
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

      {/* 1-15B : état de la section courante modifié par un collègue. */}
      {sectionPurged ? (
        <p role="status" className="text-sm text-muted-foreground">
          Ce catalogue a été supprimé définitivement.
        </p>
      ) : section?.deletedAt ? (
        <p role="status" className="text-sm text-muted-foreground">
          Ce catalogue a été placé dans la corbeille.
        </p>
      ) : null}

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
                  canManage={canManageCatalog}
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
                  canEdit={canEditProduct}
                  canDelete={canManageProducts}
                  priority={i === 0}
                  serverLoadedAt={productsLoadedAt}
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
          {(canManageCatalog || canManageProducts) && (
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
        canManageDescription={canManageProducts}
        canAdjustStock={canAdjustStock}
        onUpdated={async (id, payload) => {
          await editProduct(id, payload);
        }}
      />
    </div>
  );
}
