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
  const writeSectionScope = useCallback(
    (
      sectionId: string,
      subSections: OfflineCatalogSection[],
      products: OfflineCatalogProduct[],
    ) => {
      if (!identity) return;
      void applyCatalogScopeUpdates({
        ...identity,
        updates: [
          { kind: "section-children", sectionId, sections: subSections },
          { kind: "section-products", sectionId, products },
        ],
      });
    },
    [identity],
  );

  const readSnapshot =
    useCallback((): Promise<OfflineCatalogSnapshot | null> => {
      if (!identity) return Promise.resolve(null);
      return readCatalogSnapshot(identity);
    }, [identity]);

  return {
    writeRootSections,
    writeSectionScope,
    readSnapshot,
    hasIdentity: identity !== null,
  };
}
