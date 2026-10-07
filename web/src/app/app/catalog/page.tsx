"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { useSections } from "@/hooks/use-sections";
import { useOfflineCatalog } from "@/hooks/use-offline-catalog";
import { OfflineCatalogBrowser } from "@/components/catalog/offline-catalog-browser";
import { OfflineSalesPanelSection } from "@/components/sales/pending-sales-panel";
import { useOfflineSales } from "@/contexts/offline-sales-context";
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
  const { t } = useT("catalog");
  const format = useFormat();
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
  const { unfinalizedCount, offline, online } = useOfflineSales();

  // N'écrit qu'après un chargement COMPLET et réussi (jamais une réponse
  // partielle/en erreur) ; remplace intégralement le scope racine (jamais
  // un simple merge) — voir `applyCatalogScopeUpdates`.
  useEffect(() => {
    if (!isLoading && !error) writeRootSections(sections.map(toOfflineSection));
  }, [isLoading, error, sections, writeRootSections]);

  // Repli hors ligne : réseau coupé (`navigator.onLine === false`, ou shell
  // sans contexte serveur — voir `useOfflineSales().offline`) ou vraie panne
  // réseau de l'API (jamais sur 401/403/404/5xx), et uniquement la partition
  // courante (identité authentifiée ou vérifiée localement — jamais de
  // recherche ailleurs).
  //
  // Correctif 1-11C.3 : la bascule suit directement `offline`, sans attendre
  // une erreur API — après coupure sur une page déjà montée comme après F5
  // hors ligne. Tant qu'on est hors ligne, les `SectionCard` (liens vers
  // /app/catalog/[id]) ne sont JAMAIS rendues, même sans snapshot.
  const wantOffline = offline || (!isLoading && !!error && isOffline);
  const [offlineSnapshot, setOfflineSnapshot] = useState<{
    ready: boolean;
    snapshot: OfflineCatalogSnapshot | null;
  }>({ ready: false, snapshot: null });

  useEffect(() => {
    if (!wantOffline) {
      setOfflineSnapshot({ ready: false, snapshot: null });
      return;
    }
    let cancelled = false;
    void readSnapshot().then((snap) => {
      if (!cancelled) setOfflineSnapshot({ ready: true, snapshot: snap });
    });
    return () => {
      cancelled = true;
    };
  }, [wantOffline, readSnapshot]);

  // Retour du réseau : rechargement des sections en ligne (une seule fois
  // par transition hors ligne → en ligne).
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) void reload();
    wasOnline.current = online;
  }, [online, reload]);

  const snapshot = offlineSnapshot.snapshot;
  const showingOffline = wantOffline;
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
      toast.success(t("section.deleted"));
    } catch {
      toast.error(t("section.deleteFailed"));
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
          <h1 className="text-2xl font-semibold">{t("root.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("root.subtitle")}</p>
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
          {/* 1-11C.3a : le message hors ligne principal est affiché par le
              shell ; ici, uniquement la fraîcheur des données locales. */}
          <div className="flex flex-col gap-2 rounded-md border border-dashed p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              {snapshot
                ? t("offline.lastUpdate", {
                    date: format.dateTime(snapshot.updatedAt),
                  })
                : offlineSnapshot.ready
                  ? t("offline.noData")
                  : t("loading")}
            </p>
            {online && (
              <button
                onClick={() => void reload()}
                className="shrink-0 self-start text-xs text-primary underline underline-offset-2 hover:no-underline sm:self-auto"
              >
                {t("actions.retry")}
              </button>
            )}
          </div>
          {snapshot && <OfflineCatalogBrowser snapshot={snapshot} />}
        </>
      ) : (
        <>
          {/* Search bar */}
          <div className="relative">
            <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder={t("root.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {isLoading && (
            <p className="text-sm text-muted-foreground">{t("loading")}</p>
          )}
          {!isLoading && error && (
            <div className="flex items-center gap-3">
              <p className="text-sm text-destructive">{error}</p>
              <button
                onClick={() => void reload()}
                className="text-sm text-primary underline underline-offset-2 hover:no-underline"
              >
                {t("actions.retry")}
              </button>
            </div>
          )}
          {!isLoading && !error && sections.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("root.empty")} {canManageNow && t("root.createFirst")}
            </p>
          )}
          {!isLoading &&
            !error &&
            sections.length > 0 &&
            filtered.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {t("noResults", { query })}
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

      {/* 1-11C.3 : /app/catalog est la seule route /app servie hors ligne
          (service worker inchangé) : les ventes locales y restent
          consultables et traitables (ancre #offline-sales-panel). */}
      {unfinalizedCount > 0 && showingOffline && (
        <OfflineSalesPanelSection count={unfinalizedCount} />
      )}
    </div>
  );
}
