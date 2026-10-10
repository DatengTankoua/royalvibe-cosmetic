"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeftIcon, FolderIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { ProductCard } from "@/components/products/product-card";
import { CreateProductDialog } from "@/components/products/create-product-dialog";
import { UpdateProductDialog } from "@/components/products/update-product-dialog";
import { SectionCard } from "@/components/sections/section-card";
import { CreateSectionDialog } from "@/components/sections/create-section-dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  fetchSection,
  fetchSections,
  createSection,
  updateSection,
  deleteSection,
  fetchProductsByIds,
  fetchProductsPage,
  getApiErrorMessage,
  PRODUCTS_PAGE_SIZE,
  type ApiSection,
  type ApiProduct,
} from "@/lib/api";
import { OFFLINE_SYNC_PAGE_SIZE } from "@/lib/offline-section-sync";
import { useProducts } from "@/hooks/use-products";
import { useOfflineCatalog } from "@/hooks/use-offline-catalog";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { useOfflineSales } from "@/contexts/offline-sales-context";
import { hasPermission } from "@/lib/organization-permissions";
import type {
  OfflineCatalogProduct,
  OfflineCatalogSection,
} from "@/lib/offline-catalog-db";
import { useSocket } from "@/contexts/socket-context";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { SECTION_SIGNALS, readSectionSignal } from "@/hooks/use-sections";
import { createResponseOrder } from "@/lib/refresh-coordinator";
import { reservesStock } from "@/lib/offline-sales-policy";

type ContentMode = "loading" | "subsections" | "products" | "empty";

/** 1-20F : délai avant une recherche serveur (frappe en cours). */
const SEARCH_DELAY_MS = 300;

// 1-12H : informations standard uniquement (allowlist v3).
function toOfflineProduct(p: ApiProduct): OfflineCatalogProduct {
  return {
    _id: p._id,
    sectionId: p.sectionId,
    name: p.name,
    salePrice: p.salePrice,
    remainingQuantity: p.remainingQuantity,
    status: p.status,
  };
}

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
//
// 1-20F : produits PAGINÉS et recherchés par le serveur (tout le rayon,
// même règle qu'avant). Le cache hors ligne n'est REMPLACÉ que par une
// réponse complète (première page sans recherche ni page suivante, ou API
// antérieure) ; une page ne fait que mettre à jour ses produits. Un rayon de
// plusieurs pages est relu en entier par la synchronisation distincte,
// bornée et reprenable de `useOfflineCatalog().syncSection` (au plus une
// fois par intervalle, jamais à chaque événement).
export default function CatalogSectionPage() {
  const { t } = useT("catalog");
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
  // 1-20F : recherche serveur après une courte pause de frappe.
  const [searchQuery, setSearchQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(query), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const { writeSectionScope, writeSectionPage, removeProducts, syncSection } =
    useOfflineCatalog();

  const {
    products,
    isLoading: productsLoading,
    error,
    addProduct,
    editProduct,
    removeProduct,
    refreshProducts,
    serverLoadedAtFor,
    loadedAt: productsLoadedAt,
    total,
    scopeTotal,
    legacy,
    pageIndex,
    hasNext,
    complete,
    newerAvailable,
    goToPage,
  } = useProducts(params.id, {
    // Sous-catalogues : recherche locale seulement (aucun produit).
    query: subSections.length > 0 ? "" : searchQuery,
    onRemoved: removeProducts,
  });
  // 1-11C.3 : stock serveur rechargé après confirmation d'une vente locale.
  // 1-20D : seuls les produits affichés dont une vente confirmée n'est pas
  // encore incluse dans leur dernière lecture serveur sont relus (relecture
  // ciblée, regroupée avec le signal `sale:created` reçu par l'auteur).
  const { syncedVersion, operations } = useOfflineSales();
  const productsRef = useRef(products);
  const operationsRef = useRef(operations);
  const loadedAtForRef = useRef(serverLoadedAtFor);
  useEffect(() => {
    productsRef.current = products;
    operationsRef.current = operations;
    loadedAtForRef.current = serverLoadedAtFor;
  });
  useEffect(() => {
    if (syncedVersion === 0) return;
    const displayed = new Set(productsRef.current.map((p) => p._id));
    const ids = new Set<string>();
    for (const op of operationsRef.current) {
      const id = op.payload.productId;
      if (
        op.status === "synced" &&
        displayed.has(id) &&
        reservesStock(op, loadedAtForRef.current(id))
      ) {
        ids.add(id);
      }
    }
    refreshProducts([...ids]);
  }, [syncedVersion, refreshProducts]);

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

  // N'écrit qu'après un chargement réussi des deux appels (sous-sections +
  // produits). Réponse COMPLÈTE : remplace intégralement les deux scopes de
  // cette section en une seule transaction (jamais un simple merge).
  // 1-20F : page partielle → sous-sections remplacées, produits de la page
  // mis à jour, jamais une suppression des produits absents de la page.
  useEffect(() => {
    if (isLoading || error || productsLoadedAt === undefined) return;
    const loadedAt: Record<string, number> = {};
    for (const p of products) {
      loadedAt[p._id] = serverLoadedAtFor(p._id) ?? productsLoadedAt;
    }
    const sections = subSections.map(toOfflineSection);
    const offline = products.map(toOfflineProduct);
    if (complete) {
      writeSectionScope(
        params.id,
        sections,
        offline,
        loadedAt,
        productsLoadedAt,
      );
    } else {
      writeSectionPage(params.id, sections, offline, loadedAt);
    }
  }, [
    isLoading,
    error,
    complete,
    params.id,
    subSections,
    products,
    productsLoadedAt,
    serverLoadedAtFor,
    writeSectionScope,
    writeSectionPage,
  ]);

  // 1-20F : rayon de plusieurs pages → synchronisation hors ligne complète
  // si elle est due (parcours distinct, interrompu si le rayon est quitté).
  const activeSection = useRef<string | null>(null);
  useEffect(() => {
    activeSection.current = params.id;
    return () => {
      activeSection.current = null;
    };
  }, [params.id]);
  const multiPage =
    !legacy && scopeTotal !== null && scopeTotal > PRODUCTS_PAGE_SIZE;
  useEffect(() => {
    if (!multiPage || isLoading || error) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    const sectionId = params.id;
    void syncSection(
      sectionId,
      async (cursor) => {
        const page = await fetchProductsPage({
          sectionId,
          cursor,
          limit: OFFLINE_SYNC_PAGE_SIZE,
        });
        return {
          items: page.items.map(toOfflineProduct),
          nextCursor: page.nextCursor,
          legacy: page.legacy,
        };
      },
      () =>
        activeSection.current === sectionId &&
        (typeof navigator === "undefined" || navigator.onLine),
    );
  }, [multiPage, isLoading, error, params.id, syncSection]);

  // 1-20F : présence de produits jugée sur tout le rayon (`scopeTotal`),
  // jamais sur la page ni sur le résultat d'une recherche.
  const mode: ContentMode =
    subSectionsLoading || (productsLoading && scopeTotal === null)
      ? "loading"
      : subSections.length > 0
        ? "subsections"
        : (scopeTotal ?? 0) > 0
          ? "products"
          : "empty";
  const searching = searchQuery.trim() !== "";

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
  const backLabel = section?.parentId ? t("section.parent") : t("root.title");

  const handleDeleteProduct = async (id: string) => {
    try {
      await removeProduct(id);
      toast.success(t("product.trashed"));
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
      return;
    }
    // 1-20F : produit hors de la page affichée → lu seul (même projection).
    void fetchProductsByIds([requested], params.id)
      .then(([found]) => {
        if (found) {
          setEditTarget(found);
          setEditOpen(true);
        }
      })
      .catch(() => undefined);
  }, [products, productsLoading, canEditProduct, params.id]);

  const handleDeleteSubSection = async (id: string) => {
    try {
      await deleteSection(id);
      setSubSections((prev) => prev.filter((s) => s._id !== id));
      toast.success(t("section.subDeleted"));
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
              label={t("section.newSub")}
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

      {/* Search bar — only show when there's content (1-20F : tout le
          rayon ; conservée pendant une recherche serveur) */}
      {(mode === "subsections" || mode === "products") && (
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={
              mode === "subsections"
                ? t("section.searchSub")
                : t("section.searchProduct")
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {/* 1-15B : état de la section courante modifié par un collègue. */}
      {sectionPurged ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("section.purged")}
        </p>
      ) : section?.deletedAt ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("section.trashed")}
        </p>
      ) : null}

      {mode === "products" && newerAvailable && pageIndex > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm">
          <span>{t("section.page.changed")}</span>
          <Button variant="outline" size="sm" onClick={() => goToPage(0)}>
            {t("section.page.showFirst")}
          </Button>
        </div>
      )}

      {isLoading && (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      )}
      {!isLoading && error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {/* Sub-sections view */}
      {!isLoading && mode === "subsections" && (
        <>
          {filteredSubSections.length === 0 && query.trim() ? (
            <p className="text-sm text-muted-foreground">
              {t("noResults", { query })}
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

      {/* Products view (1-20F : page serveur, recherche comprise) */}
      {!isLoading && mode === "products" && (
        <>
          {products.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {searching
                ? t("noResults", { query: searchQuery })
                : t("section.noProducts")}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {products.map((p, i) => (
                <ProductCard
                  key={p._id}
                  product={p}
                  canEdit={canEditProduct}
                  canDelete={canManageProducts}
                  priority={i === 0}
                  serverLoadedAt={serverLoadedAtFor(p._id)}
                  onDelete={handleDeleteProduct}
                  onEdit={handleEditProduct}
                />
              ))}
            </div>
          )}
        </>
      )}

      {!isLoading && mode === "products" && !error && total !== null && (
        <nav
          aria-label={t("section.page.navLabel")}
          className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {legacy
              ? t("section.page.complete", { count: total })
              : searching
                ? t("section.page.search", {
                    count: total,
                    scope: scopeTotal ?? total,
                    page: pageIndex + 1,
                  })
                : t("section.page.summary", {
                    count: total,
                    page: pageIndex + 1,
                  })}
          </p>
          {!legacy && (pageIndex > 0 || hasNext) && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={pageIndex === 0}
                onClick={() => goToPage(0)}
              >
                {t("section.page.first")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pageIndex === 0}
                onClick={() => goToPage(pageIndex - 1)}
              >
                {t("section.page.previous")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasNext}
                onClick={() => goToPage(pageIndex + 1)}
              >
                {t("section.page.next")}
              </Button>
            </div>
          )}
        </nav>
      )}

      {/* Empty state */}
      {!isLoading && mode === "empty" && (
        <div className="flex flex-col items-center gap-4 py-16 text-center text-muted-foreground">
          <FolderIcon className="h-10 w-10 opacity-30" />
          <p className="text-sm">{t("section.empty")}</p>
          {(canManageCatalog || canManageProducts) && (
            <p className="text-xs">{t("section.emptyHint")}</p>
          )}
        </div>
      )}

      <UpdateProductDialog
        product={editTarget}
        open={editOpen}
        onOpenChange={setEditOpen}
        canManageDescription={canManageProducts}
        canAdjustStock={canAdjustStock}
        onUpdated={(id, payload) => editProduct(id, payload)}
      />
    </div>
  );
}
