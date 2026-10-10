"use client";

import { useCallback, useMemo } from "react";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import {
  applyCatalogScopeUpdates,
  readCatalogSnapshot,
  type OfflineCatalogProduct,
  type OfflineCatalogSection,
  type OfflineCatalogSnapshot,
} from "@/lib/offline-catalog-db";
import {
  OFFLINE_SYNC_INTERVAL_MS,
  runSectionSync,
  type SectionSyncOutcome,
  type SyncPage,
} from "@/lib/offline-section-sync";

// 1-20F : une synchronisation de rayon à la fois par onglet, et au plus un
// essai par intervalle (même si l'IndexedDB est indisponible ou en échec).
const syncInFlight = new Set<string>();
const syncAttemptedAt = new Map<string, number>();

// Écriture/lecture du catalogue hors ligne (1-11B, correction) : la
// partition vient de `authContext` (réseau OK) ou, à défaut, de
// `offlineIdentity` — une identité déjà vérifiée localement par le shell
// (jamais sur un 401/403, voir AppShellLayout) — jamais body/query/header/
// saisie libre. Aucune opération tant qu'aucune des deux n'est disponible.
export function useOfflineCatalog() {
  const { authContext, offlineIdentity } = useOrganizationShell();
  const identity = useMemo(
    () =>
      authContext
        ? {
            userId: authContext.userId,
            organizationId: authContext.organizationId,
          }
        : offlineIdentity,
    [authContext, offlineIdentity],
  );

  // Remplace intégralement le scope racine (sections de plus haut niveau).
  const writeRootSections = useCallback(
    (sections: OfflineCatalogSection[]) => {
      if (!identity) return;
      void applyCatalogScopeUpdates({
        ...identity,
        updates: [{ kind: "root-sections", sections }],
      });
    },
    [identity],
  );

  // Remplace intégralement les deux scopes d'une section (sous-sections +
  // produits) en une seule transaction — reflète une unique réponse
  // complète et réussie de la page de détail de section.
  // 1-20F : `loadedAt` (début de la lecture de chaque produit) et
  // `readStartedAt` (début de la lecture complète).
  const writeSectionScope = useCallback(
    (
      sectionId: string,
      subSections: OfflineCatalogSection[],
      products: OfflineCatalogProduct[],
      loadedAt?: Record<string, number>,
      readStartedAt?: number,
    ) => {
      if (!identity) return;
      void applyCatalogScopeUpdates({
        ...identity,
        updates: [
          { kind: "section-children", sectionId, sections: subSections },
          {
            kind: "section-products",
            sectionId,
            products,
            loadedAt,
            readStartedAt,
          },
        ],
      });
    },
    [identity],
  );

  // 1-20F : page d'une liste paginée — sous-sections (réponse complète)
  // remplacées, produits de la page mis à jour SANS supprimer les absents
  // ni marquer le rayon synchronisé.
  const writeSectionPage = useCallback(
    (
      sectionId: string,
      subSections: OfflineCatalogSection[],
      products: OfflineCatalogProduct[],
      loadedAt: Record<string, number>,
    ) => {
      if (!identity) return;
      void applyCatalogScopeUpdates({
        ...identity,
        updates: [
          { kind: "section-children", sectionId, sections: subSections },
          { kind: "products-upsert", products, loadedAt },
        ],
      });
    },
    [identity],
  );

  // 1-20F : produits retirés (corbeille, purge) ou déplacés hors du rayon
  // affiché (`keepInSectionId` : leur nouveau rayon).
  const removeProducts = useCallback(
    (ids: string[], keepInSectionId?: string) => {
      if (!identity || ids.length === 0) return;
      void applyCatalogScopeUpdates({
        ...identity,
        updates: [{ kind: "products-remove", ids, keepInSectionId }],
      });
    },
    [identity],
  );

  const readSnapshot =
    useCallback((): Promise<OfflineCatalogSnapshot | null> => {
      if (!identity) return Promise.resolve(null);
      return readCatalogSnapshot(identity);
    }, [identity]);

  /**
   * 1-20F : synchronisation complète d'un rayon (parcours distinct, borné et
   * reprenable, `offline-section-sync.ts`), seulement si elle est due.
   */
  const syncSection = useCallback(
    async (
      sectionId: string,
      fetchPage: (cursor: string | null) => Promise<SyncPage>,
      shouldContinue: () => boolean,
    ): Promise<SectionSyncOutcome | "skipped"> => {
      if (!identity) return "skipped";
      const key = `${identity.userId}:${identity.organizationId}:${sectionId}`;
      const now = Date.now();
      const last = syncAttemptedAt.get(key);
      if (
        syncInFlight.has(key) ||
        (last !== undefined && now - last < OFFLINE_SYNC_INTERVAL_MS)
      ) {
        return "skipped";
      }
      syncInFlight.add(key);
      try {
        const outcome = await runSectionSync({
          sectionId,
          readSnapshot: () => readCatalogSnapshot(identity),
          fetchPage,
          apply: (updates) =>
            applyCatalogScopeUpdates({ ...identity, updates }),
          shouldContinue,
        });
        // Interrompue : reprise permise à la prochaine ouverture.
        if (outcome !== "paused") syncAttemptedAt.set(key, Date.now());
        return outcome;
      } catch {
        // Réseau ou API : progression conservée, reprise après l'intervalle
        // (jamais un nouvel essai à chaque ouverture).
        syncAttemptedAt.set(key, Date.now());
        return "paused";
      } finally {
        syncInFlight.delete(key);
      }
    },
    [identity],
  );

  return {
    writeRootSections,
    writeSectionScope,
    writeSectionPage,
    removeProducts,
    readSnapshot,
    syncSection,
    hasIdentity: identity !== null,
  };
}
