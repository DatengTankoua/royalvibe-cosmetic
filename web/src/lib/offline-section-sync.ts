// 1-20F — Synchronisation COMPLÈTE d'un rayon pour le catalogue hors ligne.
//
// Avant 1-20F, chaque ouverture d'un rayon chargeait tous ses produits et
// remplaçait son scope hors ligne. La liste étant désormais paginée, une page
// ne remplace jamais ce scope (`products-upsert`, sans suppression) ; le
// rayon complet est relu par ce parcours DISTINCT :
// - seulement si le scope n'a jamais été synchronisé ou date de plus de
//   `OFFLINE_SYNC_INTERVAL_MS` — jamais à chaque ouverture ni événement ;
// - page par page (`OFFLINE_SYNC_PAGE_SIZE`), séquentiellement, au plus
//   `OFFLINE_SYNC_MAX_PAGES` pages PAR PASSAGE, sans reprise au-delà : un
//   rayon plus grand reste partiel hors ligne (produits les plus récents
//   seulement, scope NON marqué synchronisé, indiqué par le navigateur) ;
// - reprenable : la progression est enregistrée après chaque page et reprise
//   au passage suivant si elle a moins de `OFFLINE_SYNC_RESUME_MS`
//   (au-delà : recommencée, pour ne jamais assembler des lectures trop
//   éloignées) ;
// - interrompue entre deux pages si `shouldContinue()` devient faux (rayon
//   quitté, session changée, hors ligne).
// Délais par onglet (`nextSyncAllowedAt`) : aucun après une interruption,
// `OFFLINE_SYNC_RETRY_MS` (< `OFFLINE_SYNC_RESUME_MS`) après un échec,
// `OFFLINE_SYNC_INTERVAL_MS` après un passage terminé ou tronqué.
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

/**
 * Issue d'un passage :
 * - `complete` : rayon remplacé et marqué synchronisé ;
 * - `truncated` : plafond atteint, produits lus conservés, rayon NON
 *   synchronisé ;
 * - `interrupted` : rayon quitté ou connexion perdue entre deux pages ;
 *   progression enregistrée, reprise possible ;
 * - `failed` : écriture locale refusée (ou, côté appelant, erreur réseau ou
 *   API) ; progression déjà enregistrée conservée ;
 * - `not-needed` : dernière synchronisation trop récente.
 */
export type SectionSyncOutcome =
  "complete" | "truncated" | "interrupted" | "failed" | "not-needed";

/**
 * Délai avant un nouvel essai après un échec : STRICTEMENT inférieur à la
 * fenêtre de reprise, pour qu'un échec ne fasse jamais perdre la
 * progression, et non nul, pour qu'un échec persistant ne produise jamais
 * une tentative par ouverture ou par rendu.
 */
export const OFFLINE_SYNC_RETRY_MS = 2 * 60 * 1000;

/** Prochain passage permis (ms) dans cet onglet, selon l'issue du précédent. */
export function nextSyncAllowedAt(
  outcome: SectionSyncOutcome,
  finishedAt: number,
): number {
  switch (outcome) {
    case "interrupted":
      // Reprise dès la prochaine ouverture du rayon en ligne.
      return finishedAt;
    case "failed":
      return finishedAt + OFFLINE_SYNC_RETRY_MS;
    default:
      return finishedAt + OFFLINE_SYNC_INTERVAL_MS;
  }
}

/**
 * Garde par onglet : un seul passage à la fois par rayon, et aucun passage
 * avant le délai fixé par l'issue du précédent.
 */
export function createSectionSyncGate() {
  const inFlight = new Set<string>();
  const allowedAt = new Map<string, number>();
  return {
    tryStart(key: string, now: number): boolean {
      if (inFlight.has(key) || now < (allowedAt.get(key) ?? -Infinity)) {
        return false;
      }
      inFlight.add(key);
      return true;
    },
    finish(key: string, outcome: SectionSyncOutcome, now: number): void {
      inFlight.delete(key);
      allowedAt.set(key, nextSyncAllowedAt(outcome, now));
    },
  };
}

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
      return ok ? "complete" : "failed";
    }
    if (pages >= OFFLINE_SYNC_MAX_PAGES) {
      // Plafond PAR PASSAGE, sans reprise : le passage suivant (après
      // l'intervalle) recommence en tête et relit les mêmes produits les
      // plus récents ; les plus anciens ne viennent que des pages affichées.
      const ok = await deps.apply([
        { kind: "products-upsert", products, loadedAt },
        { kind: "sync-progress", scope: key, pending: null, finishedAt: now() },
      ]);
      return ok ? "truncated" : "failed";
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
      return "failed";
    }
  }
  return "interrupted";
}
