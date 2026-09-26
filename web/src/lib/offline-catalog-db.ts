// Catalogue hors ligne (1-11B) : IndexedDB natif uniquement (jamais
// localStorage/Cache Storage), module isolé/typé/versionné. Une seule
// partition active à la fois, clé stricte `${userId}:${organizationId}`
// dérivée exclusivement d'une source déjà authentifiée (jamais body/query/
// header/saisie libre) — voir docs/architecture/phase-1-11b-offline-catalog.md.
import {
  withTimeout,
  attachVersionChangeAutoClose,
  deleteIndexedDb,
} from "./offline-db-utils";

export const OFFLINE_CATALOG_SCHEMA_VERSION = 2; // v2 : ajout syncedScopes (remplacement par scope)
export const OFFLINE_CATALOG_TTL_MS = 72 * 60 * 60 * 1000; // 72h
const OP_TIMEOUT_MS = 2000;

const DB_NAME = "stockmaster-offline-catalog";
const DB_VERSION = 1;
const STORE_NAME = "catalogSnapshots";

// Allowlist stricte : uniquement le stock/prix déjà visibles dans le
// catalogue. Jamais imageUrl (image = réseau uniquement), jamais
// unitsSold/estimatedProfit/estimatedRevenue/totalPurchaseCost (dérivés des
// ventes = analytics, explicitement interdits hors ligne).
export interface OfflineCatalogSection {
  _id: string;
  name: string;
  description: string;
  parentId: string | null;
}

export interface OfflineCatalogProduct {
  _id: string;
  sectionId: string;
  name: string;
  purchasePrice: number;
  salePrice: number;
  initialQuantity: number;
  remainingQuantity: number;
  status: "in_stock" | "low_stock" | "out_of_stock";
}

// Un scope = la portée exacte d'une réponse API complète. Rechargé en
// entier à chaque écriture (jamais un simple merge) — voir
// `applyCatalogScopeUpdates`.
export type CatalogScope =
  | { kind: "root-sections" }
  | { kind: "section-children"; sectionId: string }
  | { kind: "section-products"; sectionId: string };

export function scopeKey(scope: CatalogScope): string {
  switch (scope.kind) {
    case "root-sections":
      return "root-sections";
    case "section-children":
      return `section-children:${scope.sectionId}`;
    case "section-products":
      return `section-products:${scope.sectionId}`;
  }
}

export interface OfflineCatalogSnapshot {
  schemaVersion: number;
  userId: string;
  organizationId: string;
  updatedAt: string; // ISO 8601
  sections: OfflineCatalogSection[];
  products: OfflineCatalogProduct[];
  // Scopes ayant reçu au moins une réponse complète réussie — distingue
  // "scope synchronisé vide" de "scope jamais synchronisé" côté UI.
  syncedScopes: string[];
}

// ─── Fonctions pures (testables sans IndexedDB) ─────────────────────────────

export function partitionKey(userId: string, organizationId: string): string {
  return `${userId}:${organizationId}`;
}

// Vérifie schemaVersion + partition exacte + fraîcheur — jamais de fallback
// vers une autre partition, jamais toléré au-delà du TTL.
export function isSnapshotUsable(
  record: unknown,
  userId: string,
  organizationId: string,
  now: number = Date.now(),
): record is OfflineCatalogSnapshot {
  if (!record || typeof record !== "object") return false;
  const s = record as Partial<OfflineCatalogSnapshot>;
  if (s.schemaVersion !== OFFLINE_CATALOG_SCHEMA_VERSION) return false;
  if (s.userId !== userId || s.organizationId !== organizationId) return false;
  if (!Array.isArray(s.sections) || !Array.isArray(s.products)) return false;
  if (!Array.isArray(s.syncedScopes)) return false;
  const updatedAtMs =
    typeof s.updatedAt === "string" ? Date.parse(s.updatedAt) : NaN;
  if (!Number.isFinite(updatedAtMs)) return false;
  return now - updatedAtMs <= OFFLINE_CATALOG_TTL_MS;
}

function sectionBelongsToScope(
  section: OfflineCatalogSection,
  scope: CatalogScope,
): boolean {
  if (scope.kind === "root-sections") return section.parentId === null;
  if (scope.kind === "section-children")
    return section.parentId === scope.sectionId;
  return false;
}

function productBelongsToScope(
  product: OfflineCatalogProduct,
  scope: CatalogScope,
): boolean {
  return (
    scope.kind === "section-products" && product.sectionId === scope.sectionId
  );
}

function emptySnapshot(
  userId: string,
  organizationId: string,
): OfflineCatalogSnapshot {
  return {
    schemaVersion: OFFLINE_CATALOG_SCHEMA_VERSION,
    userId,
    organizationId,
    updatedAt: new Date().toISOString(),
    sections: [],
    products: [],
    syncedScopes: [],
  };
}

type ScopeUpdate =
  | { kind: "root-sections"; sections: OfflineCatalogSection[] }
  | {
      kind: "section-children";
      sectionId: string;
      sections: OfflineCatalogSection[];
    }
  | {
      kind: "section-products";
      sectionId: string;
      products: OfflineCatalogProduct[];
    };

// Le discriminant imbriqué (`update.scope.kind`) ne réduit pas le type de
// `update` en TypeScript (limitation connue) : `kind` est donc dupliqué au
// niveau supérieur de `ScopeUpdate` pour un narrowing fiable ; ce helper
// reconstruit le `CatalogScope` correspondant pour les fonctions ci-dessus.
function updateScope(update: ScopeUpdate): CatalogScope {
  if (update.kind === "root-sections") return { kind: "root-sections" };
  return { kind: update.kind, sectionId: update.sectionId };
}

// Applique un ou plusieurs remplacements de scope sur la base existante :
// retire les anciennes entrées du scope, élimine globalement tout _id
// réinséré (même hors du scope), insère la nouvelle réponse (même vide),
// marque le(s) scope(s) synchronisé(s) — jamais un simple merge par _id,
// jamais touché : les autres scopes déjà synchronisés.
export function applyScopeUpdatesToSnapshot(
  base: OfflineCatalogSnapshot,
  updates: ScopeUpdate[],
): OfflineCatalogSnapshot {
  let sections = base.sections;
  let products = base.products;
  const syncedScopes = new Set(base.syncedScopes);

  for (const update of updates) {
    const scope = updateScope(update);
    if (update.kind === "section-products") {
      products = products.filter((p) => !productBelongsToScope(p, scope));
      const incomingIds = new Set(update.products.map((p) => p._id));
      products = products.filter((p) => !incomingIds.has(p._id));
      products = products.concat(update.products);
    } else {
      sections = sections.filter((s) => !sectionBelongsToScope(s, scope));
      const incomingIds = new Set(update.sections.map((s) => s._id));
      sections = sections.filter((s) => !incomingIds.has(s._id));
      sections = sections.concat(update.sections);
    }
    syncedScopes.add(scopeKey(scope));
  }

  return {
    schemaVersion: OFFLINE_CATALOG_SCHEMA_VERSION,
    userId: base.userId,
    organizationId: base.organizationId,
    updatedAt: new Date().toISOString(),
    sections,
    products,
    syncedScopes: Array.from(syncedScopes),
  };
}

// ─── Accès IndexedDB (jamais de log du contenu — message générique only) ───

function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      attachVersionChangeAutoClose(request.result);
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

function warnGeneric(action: string): void {
  // Jamais le contenu de l'erreur (pourrait référencer la donnée stockée) :
  // uniquement un message fixe, sans erreur ni snapshot interpolés.
  console.warn(`Offline catalog: ${action} indisponible.`);
}

// Lecture stricte d'une seule partition — jamais de recherche/fallback vers
// une autre. Un enregistrement expiré/invalide est supprimé puis ignoré.
export async function readCatalogSnapshot(params: {
  userId: string;
  organizationId: string;
}): Promise<OfflineCatalogSnapshot | null> {
  if (!isIndexedDbAvailable()) return null;
  const key = partitionKey(params.userId, params.organizationId);
  const run = async (): Promise<OfflineCatalogSnapshot | null> => {
    let db: IDBDatabase;
    try {
      db = await openDb();
    } catch {
      warnGeneric("ouverture");
      return null;
    }
    try {
      const record = await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (isSnapshotUsable(record, params.userId, params.organizationId)) {
        return record;
      }
      if (record !== undefined) {
        // Invalide/expiré : purgé immédiatement, jamais retourné.
        await deletePartition(key);
      }
      return null;
    } catch {
      warnGeneric("lecture");
      return null;
    } finally {
      db.close();
    }
  };
  return withTimeout(run(), OP_TIMEOUT_MS, () => null);
}

// Une seule transaction get/compute/put par appel : lit le snapshot existant
// de la partition, applique le(s) remplacement(s) de scope, réécrit le
// résultat — jamais appelée pour une réponse partielle/en erreur (le
// scope reçu doit être une réponse API complète et réussie, même vide).
export async function applyCatalogScopeUpdates(params: {
  userId: string;
  organizationId: string;
  updates: ScopeUpdate[];
}): Promise<boolean> {
  if (!isIndexedDbAvailable()) return false;
  const key = partitionKey(params.userId, params.organizationId);
  const run = async (): Promise<boolean> => {
    let db: IDBDatabase;
    try {
      db = await openDb();
    } catch {
      warnGeneric("ouverture");
      return false;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(key);
        getReq.onsuccess = () => {
          const existing = getReq.result as unknown;
          const base = isSnapshotUsable(
            existing,
            params.userId,
            params.organizationId,
          )
            ? existing
            : emptySnapshot(params.userId, params.organizationId);
          const snapshot = applyScopeUpdatesToSnapshot(base, params.updates);
          store.put(snapshot, key);
        };
        getReq.onerror = () => reject(getReq.error);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return true;
    } catch {
      warnGeneric("écriture");
      return false;
    } finally {
      db.close();
    }
  };
  return withTimeout(run(), OP_TIMEOUT_MS, () => false);
}

async function deletePartition(key: string): Promise<void> {
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    warnGeneric("purge partielle");
  }
}

// Purge totale (logout, switch d'organisation réussi, bouton manuel) :
// supprime toute la base — jamais une simple partition — pour ne jamais
// laisser de données d'un autre utilisateur/organisation en cache.
export async function clearAllOfflineCatalogData(): Promise<boolean> {
  return deleteIndexedDb(DB_NAME);
}
