// 1-20F — Synchronisation COMPLÈTE d'un rayon pour le catalogue hors ligne.
//
// Avant 1-20F, chaque ouverture d'un rayon chargeait tous ses produits et
// remplaçait son scope hors ligne. La liste étant désormais paginée, une page
// ne remplace jamais ce scope (`products-upsert`, sans suppression) ; le
// rayon complet est relu par ce parcours DISTINCT :
// - seulement si le scope n'a jamais été synchronisé ou date de plus de
//   `OFFLINE_SYNC_INTERVAL_MS` — jamais à chaque ouverture ni événement ;
// - page par page (`OFFLINE_SYNC_PAGE_SIZE`), séquentiellement, au plus
//   `OFFLINE_SYNC_MAX_PAGES` pages (au-delà : produits lus conservés, scope
//   NON marqué synchronisé, le navigateur hors ligne l'indique partiel) ;
// - reprenable : la progression est enregistrée après chaque page et reprise
//   à la prochaine ouverture si elle a moins de `OFFLINE_SYNC_RESUME_MS`
//   (au-delà : recommencée, pour ne jamais assembler des lectures trop
//   éloignées) ;
// - interrompue entre deux pages si `shouldContinue()` devient faux (rayon
//   quitté, session changée, hors ligne).
// Seuls les champs standard sont conservés (allowlist de l'IndexedDB).
import {
  scopeKey,
  type OfflineCatalogProduct,
  type OfflineCatalogSnapshot,
  type PendingScopeSync,
  type ScopeUpdate,
} from "./offline-catalog-db";

export const OFFLINE_SYNC_PAGE_SIZE = 100;
export const OFFLINE_SYNC_MAX_PAGES = 50;
export const OFFLINE_SYNC_INTERVAL_MS = 15 * 60 * 1000;
export const OFFLINE_SYNC_RESUME_MS = 10 * 60 * 1000;

export interface SyncPage {
  items: OfflineCatalogProduct[];
  nextCursor: string | null;
  /** API antérieure : tableau complet du rayon en une réponse. */
  legacy: boolean;
}

export type SectionSyncOutcome =
  "complete" | "paused" | "truncated" | "not-needed";

export function sectionProductsScope(sectionId: string): string {
  return scopeKey({ kind: "section-products", sectionId });
}

/** Synchronisation à lancer pour ce rayon ? */
export function needsSectionSync(
  snapshot: OfflineCatalogSnapshot | null,
  sectionId: string,
  now: number,
): boolean {
  if (!snapshot) return true;
  // Dernière synchronisation terminée (complète ou tronquée) ; inconnue
  // (jamais faite, snapshot antérieur) : à faire.
  const at = snapshot.scopeSyncedAt?.[sectionProductsScope(sectionId)];
  return at === undefined || now - at > OFFLINE_SYNC_INTERVAL_MS;
}

export async function runSectionSync(deps: {
  sectionId: string;
  readSnapshot: () => Promise<OfflineCatalogSnapshot | null>;
  fetchPage: (cursor: string | null) => Promise<SyncPage>;
  apply: (updates: ScopeUpdate[]) => Promise<boolean>;
  shouldContinue: () => boolean;
  now?: () => number;
}): Promise<SectionSyncOutcome> {
  const now = deps.now ?? Date.now;
  const key = sectionProductsScope(deps.sectionId);
  const snapshot = await deps.readSnapshot();
  if (!needsSectionSync(snapshot, deps.sectionId, now())) return "not-needed";
  const saved = snapshot?.pendingSyncs?.[key];
  let state: PendingScopeSync | null =
    saved && now() - saved.updatedAt < OFFLINE_SYNC_RESUME_MS ? saved : null;
  let cursor = state?.cursor ?? null;

  while (deps.shouldContinue()) {
    const requestedAt = now();
    const page = await deps.fetchPage(cursor);
    const loadedAt: Record<string, number> = { ...(state?.loadedAt ?? {}) };
    const byId = new Map(
      (state?.products ?? []).map((p) => [p._id, p] as const),
    );
    for (const p of page.items) {
      byId.set(p._id, p);
      loadedAt[p._id] = requestedAt;
    }
    const startedAt = state?.startedAt ?? requestedAt;
    const pages = (state?.pages ?? 0) + 1;
    const products = [...byId.values()];

    if (page.legacy || page.nextCursor === null) {
      const ok = await deps.apply([
        {
          kind: "section-products",
          sectionId: deps.sectionId,
          products,
          loadedAt,
          readStartedAt: startedAt,
        },
        { kind: "sync-progress", scope: key, pending: null },
      ]);
      return ok ? "complete" : "paused";
    }
    if (pages >= OFFLINE_SYNC_MAX_PAGES) {
      await deps.apply([
        { kind: "products-upsert", products, loadedAt },
        // Tronquée : pas de nouvel essai avant l'intervalle.
        { kind: "sync-progress", scope: key, pending: null, finishedAt: now() },
      ]);
      return "truncated";
    }
    state = {
      startedAt,
      updatedAt: now(),
      cursor: page.nextCursor,
      pages,
      products,
      loadedAt,
    };
    cursor = page.nextCursor;
    if (
      !(await deps.apply([
        { kind: "sync-progress", scope: key, pending: state },
      ]))
    ) {
      return "paused";
    }
  }
  return "paused";
}
