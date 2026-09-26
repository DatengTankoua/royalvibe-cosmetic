"use client";

import { useEffect, useMemo, useState } from "react";
import { SearchIcon, WifiOffIcon } from "lucide-react";
import { toast } from "sonner";
import { useSections } from "@/hooks/use-sections";
import { useOfflineCatalog } from "@/hooks/use-offline-catalog";
import { OfflineCatalogBrowser } from "@/components/catalog/offline-catalog-browser";
import { SectionCard } from "@/components/sections/section-card";
import { CreateSectionDialog } from "@/components/sections/create-section-dialog";
import { Input } from "@/components/ui/input";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { hasPermission } from "@/lib/organization-permissions";
import type { ApiSection } from "@/lib/api";
import type {
  OfflineCatalogSection,
  OfflineCatalogSnapshot,
} from "@/lib/offline-catalog-db";

function toOfflineSection(s: ApiSection): OfflineCatalogSection {
  return {
    _id: s._id,
    name: s.name,
    description: s.description,
    parentId: s.parentId ?? null,
  };
}

// /app/catalog (1-9D, ex "/") : catalogue racine, lecture ouverte à tout
// membre actif (aucune permission requise côté backend). Gestion
// (créer/renommer/supprimer une section) → `catalog.manage`, jamais
// `User.role`/`ApiUser.role`. L'auth est déjà gardée par le shell (/app/layout.tsx).
//
// Hors ligne (1-11B, correction) : toute la navigation interne
// (sous-sections, produits, détail produit minimal) se fait DANS cette page
// via `OfflineCatalogBrowser` — jamais de route dynamique
// (/app/catalog/[id], /app/catalog/products/[id]) tant qu'on est hors ligne,
// pour ne pas dépendre d'un document Next indisponible sans réseau.
export default function CatalogPage() {
  const { authContext } = useOrganizationShell();
  const canManage = hasPermission(authContext, "catalog.manage");
  const [query, setQuery] = useState("");
  const {
    sections,
    isLoading,
    error,
    isOffline,
    reload,
    addSection,
    removeSection,
    renameSection,
  } = useSections();
  const { writeRootSections, readSnapshot } = useOfflineCatalog();

  // N'écrit qu'après un chargement COMPLET et réussi (jamais une réponse
  // partielle/en erreur) ; remplace intégralement le scope racine (jamais
  // un simple merge) — voir `applyCatalogScopeUpdates`.
  useEffect(() => {
    if (!isLoading && !error) writeRootSections(sections.map(toOfflineSection));
  }, [isLoading, error, sections, writeRootSections]);

  // Repli hors ligne : uniquement sur une vraie panne réseau (jamais sur
  // 401/403/404/5xx), et uniquement la partition courante (identité
  // authentifiée ou vérifiée localement — jamais de recherche ailleurs).
  const [offlineSnapshot, setOfflineSnapshot] =
    useState<OfflineCatalogSnapshot | null>(null);

  useEffect(() => {
    if (isLoading || !error || !isOffline) {
      setOfflineSnapshot(null);
      return;
    }
    let cancelled = false;
    void readSnapshot().then((snap) => {
      if (!cancelled) setOfflineSnapshot(snap);
    });
    return () => {
      cancelled = true;
    };
  }, [isLoading, error, isOffline, readSnapshot]);

  const showingOffline = offlineSnapshot !== null;
  const canManageNow = canManage && !showingOffline;

  const filtered = useMemo(
    () =>
      query.trim()
        ? sections.filter((s) =>
            s.name.toLowerCase().includes(query.toLowerCase()),
          )
        : sections,
    [sections, query],
  );

  const handleDelete = async (id: string) => {
    try {
      await removeSection(id);
      toast.success("Section supprimée");
    } catch {
      toast.error("Impossible de supprimer la section");
    }
  };

  const handleRename = async (
    id: string,
    name: string,
    description: string,
  ) => {
    await renameSection(id, name, description);
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Catalogue</h1>
          <p className="text-sm text-muted-foreground">
            Sélectionne une catégorie pour voir les produits
          </p>
        </div>
        {canManageNow && (
          <CreateSectionDialog
            onCreated={async (name, description) => {
              await addSection(name, description);
            }}
          />
        )}
      </div>

      {showingOffline ? (
        <>
          <div className="flex flex-col gap-2 rounded-md border border-dashed p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <span
                role="status"
                className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive"
              >
                <WifiOffIcon className="h-3.5 w-3.5" aria-hidden />
                Données hors connexion
              </span>
              <p className="text-xs text-muted-foreground">
                Dernière synchronisation :{" "}
                {new Date(offlineSnapshot.updatedAt).toLocaleString("fr-FR")} —
                ces données peuvent être anciennes. Lecture seule.
              </p>
            </div>
            <button
              onClick={() => void reload()}
              className="shrink-0 text-xs text-primary underline underline-offset-2 hover:no-underline"
            >
              Réessayer
            </button>
          </div>
          <OfflineCatalogBrowser snapshot={offlineSnapshot} />
        </>
      ) : (
        <>
          {/* Search bar */}
          <div className="relative">
            <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Rechercher un catalogue…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {isLoading && (
            <p className="text-sm text-muted-foreground">Chargement…</p>
          )}
          {!isLoading && error && (
            <div className="flex items-center gap-3">
              <p className="text-sm text-destructive">{error}</p>
              <button
                onClick={() => void reload()}
                className="text-sm text-primary underline underline-offset-2 hover:no-underline"
              >
                Réessayer
              </button>
            </div>
          )}
          {!isLoading && !error && sections.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Aucune section.{" "}
              {canManageNow && "Crée la première section ci-dessus."}
            </p>
          )}
          {!isLoading &&
            !error &&
            sections.length > 0 &&
            filtered.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Aucun résultat pour « {query} ».
              </p>
            )}
          {!isLoading && !error && filtered.length > 0 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((s) => (
                <SectionCard
                  key={s._id}
                  section={s}
                  canManage={canManageNow}
                  onDelete={handleDelete}
                  onRename={canManageNow ? handleRename : undefined}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
