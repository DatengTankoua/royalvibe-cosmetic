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

// v2 : ajout syncedScopes (remplacement par scope).
// v3 (1-12H) : purchasePrice/initialQuantity retirés de l'allowlist — tout
// snapshot v2 (qui peut les contenir) est rejeté par `isSnapshotUsable`,
// purgé à la lecture et remplacé à l'écriture. L'outbox des ventes est une
// base distincte (`stockmaster-offline-sales-outbox`), jamais touchée ici.
export const OFFLINE_CATALOG_SCHEMA_VERSION = 3;
export const OFFLINE_CATALOG_TTL_MS = 72 * 60 * 60 * 1000; // 72h
const OP_TIMEOUT_MS = 2000;

const DB_NAME = "stockmaster-offline-catalog";
const DB_VERSION = 1;
const STORE_NAME = "catalogSnapshots";

// Allowlist stricte : uniquement les informations STANDARD (1-12H) — nom,
// prix de vente cible, stock restant, statut. Jamais imageUrl (image =
// réseau uniquement), jamais le prix d'achat ni le stock initial (droits
// supplémentaires non vérifiables hors ligne), jamais de métrique dérivée
// des ventes.
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
  salePrice: number;
  remainingQuantity: number;
  status: "in_stock" | "low_stock" | "out_of_stock";
}

/**
 * Copie défensive vers l'allowlist (1-12H) : même si l'appelant passe un
 * objet plus riche (ex. produit API complet), seuls ces champs sont
 * persistés dans IndexedDB.
 */
export function toOfflineCatalogProduct(
  p: OfflineCatalogProduct,
): OfflineCatalogProduct {
  return {
    _id: p._id,
    sectionId: p.sectionId,
    name: p.name,
    salePrice: p.salePrice,
    remainingQuantity: p.remainingQuantity,
    status: p.status,
  };
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
  // 1-20F — champs FACULTATIFS (même schemaVersion : une version antérieure
  // les ignore et les abandonne à sa prochaine écriture, sans autre effet) :
  // - début de la lecture serveur ayant fourni chaque produit (ms), borne des
  //   ventes locales déjà reflétées (1-11C.3) ; à défaut `updatedAt` ;
  // - date (ms) de la dernière réponse complète de chaque scope ;
  // - synchronisation complète d'un rayon en cours (reprise, voir
  //   `offline-section-sync.ts`).
  productLoadedAt?: Record<string, number>;
  scopeSyncedAt?: Record<string, number>;
  pendingSyncs?: Record<string, PendingScopeSync>;
}

/** 1-20F — Pages déjà lues d'une synchronisation complète de rayon. */
export interface PendingScopeSync {
  startedAt: number;
  updatedAt: number;
  cursor: string;
  pages: number;
  products: OfflineCatalogProduct[];
  loadedAt: Record<string, number>;
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

export type ScopeUpdate =
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
      // 1-20F : début de la lecture de chaque produit, et début de la lecture
      // complète. Un produit du rayon relu APRÈS ce début (page consultée
      // pendant une synchronisation) est conservé dans sa version plus
      // récente, même s'il manque à la réponse complète (créé entre-temps).
      loadedAt?: Record<string, number>;
      readStartedAt?: number;
    }
  // 1-20F : page d'une liste paginée — mise à jour des seuls produits reçus
  // (jamais une suppression des absents, jamais un scope marqué synchronisé).
  | {
      kind: "products-upsert";
      products: OfflineCatalogProduct[];
      loadedAt: Record<string, number>;
    }
  // 1-20F : produits mis à la corbeille, purgés ou déplacés (signal) ;
  // `keepInSectionId` : conservé s'il est déjà rangé dans ce rayon.
  | { kind: "products-remove"; ids: string[]; keepInSectionId?: string }
  // 1-20F : progression d'une synchronisation complète (`null` : terminée).
  // `finishedAt` : fin d'une synchronisation tronquée (aucun nouvel essai
  // avant l'intervalle, scope toujours NON synchronisé).
  | {
      kind: "sync-progress";
      scope: string;
      pending: PendingScopeSync | null;
      finishedAt?: number;
    };

type ScopeReplacement = Extract<
  ScopeUpdate,
  { kind: "root-sections" | "section-children" | "section-products" }
>;

// Le discriminant imbriqué (`update.scope.kind`) ne réduit pas le type de
// `update` en TypeScript (limitation connue) : `kind` est donc dupliqué au
// niveau supérieur de `ScopeUpdate` pour un narrowing fiable ; ce helper
// reconstruit le `CatalogScope` correspondant pour les fonctions ci-dessus.
function updateScope(update: ScopeReplacement): CatalogScope {
  if (update.kind === "root-sections") return { kind: "root-sections" };
  return { kind: update.kind, sectionId: update.sectionId };
}

/** Version reçue plus ancienne que celle déjà enregistrée ? */
function isOlder(
  stored: Record<string, number>,
  id: string,
  incoming: number | undefined,
): boolean {
  const current = stored[id];
  return current !== undefined && incoming !== undefined && current > incoming;
}

// Applique un ou plusieurs remplacements de scope sur la base existante :
// retire les anciennes entrées du scope, élimine globalement tout _id
// réinséré (même hors du scope), insère la nouvelle réponse (même vide),
// marque le(s) scope(s) synchronisé(s) — jamais un simple merge par _id,
// jamais touché : les autres scopes déjà synchronisés.
// 1-20F : mises à jour partielles (`products-upsert`, `products-remove`,
// `sync-progress`) qui ne marquent jamais un scope synchronisé ; une
// version plus ancienne d'un produit n'écrase jamais une plus récente.
export function applyScopeUpdatesToSnapshot(
  base: OfflineCatalogSnapshot,
  updates: ScopeUpdate[],
  now: number = Date.now(),
): OfflineCatalogSnapshot {
  let sections = base.sections;
  let products = base.products;
  const syncedScopes = new Set(base.syncedScopes);
  const productLoadedAt = { ...(base.productLoadedAt ?? {}) };
  const scopeSyncedAt = { ...(base.scopeSyncedAt ?? {}) };
  const pendingSyncs = { ...(base.pendingSyncs ?? {}) };

  for (const update of updates) {
    if (update.kind === "products-upsert") {
      for (const incoming of update.products) {
        const at = update.loadedAt[incoming._id];
        if (isOlder(productLoadedAt, incoming._id, at)) continue;
        const copy = toOfflineCatalogProduct(incoming);
        const index = products.findIndex((p) => p._id === incoming._id);
        products =
          index < 0
            ? products.concat(copy)
            : products.map((p, i) => (i === index ? copy : p));
        if (at !== undefined) productLoadedAt[incoming._id] = at;
      }
      continue;
    }
    if (update.kind === "products-remove") {
      const ids = new Set(update.ids);
      products = products.filter(
        (p) =>
          !ids.has(p._id) ||
          (update.keepInSectionId !== undefined &&
            p.sectionId === update.keepInSectionId),
      );
      continue;
    }
    if (update.kind === "sync-progress") {
      if (update.pending) pendingSyncs[update.scope] = update.pending;
      else delete pendingSyncs[update.scope];
      if (update.finishedAt !== undefined) {
        scopeSyncedAt[update.scope] = update.finishedAt;
      }
      continue;
    }
    const scope = updateScope(update);
    if (update.kind === "section-products") {
      const loadedAt = update.loadedAt ?? {};
      const readStartedAt = update.readStartedAt;
      const incomingIds = new Set(update.products.map((p) => p._id));
      // Version enregistrée relue APRÈS celle de cette réponse complète
      // (produit reçu) ou après son début (produit du rayon absent).
      const fresher = products.filter((p) =>
        incomingIds.has(p._id)
          ? isOlder(productLoadedAt, p._id, loadedAt[p._id] ?? readStartedAt)
          : productBelongsToScope(p, scope) &&
            isOlder(productLoadedAt, p._id, readStartedAt),
      );
      const fresherIds = new Set(fresher.map((p) => p._id));
      products = products.filter(
        (p) =>
          !productBelongsToScope(p, scope) &&
          !incomingIds.has(p._id) &&
          !fresherIds.has(p._id),
      );
      products = products
        .concat(fresher)
        .concat(
          update.products
            .filter((p) => !fresherIds.has(p._id))
            .map(toOfflineCatalogProduct),
        );
      for (const p of update.products) {
        if (fresherIds.has(p._id)) continue;
        const at = loadedAt[p._id] ?? readStartedAt;
        if (at !== undefined) productLoadedAt[p._id] = at;
        else delete productLoadedAt[p._id];
      }
    } else {
      sections = sections.filter((s) => !sectionBelongsToScope(s, scope));
      const incomingIds = new Set(update.sections.map((s) => s._id));
      sections = sections.filter((s) => !incomingIds.has(s._id));
      sections = sections.concat(update.sections);
    }
    syncedScopes.add(scopeKey(scope));
    scopeSyncedAt[scopeKey(scope)] = now;
  }

  // Dates des seuls produits encore présents.
  const present = new Set(products.map((p) => p._id));
  for (const id of Object.keys(productLoadedAt)) {
    if (!present.has(id)) delete productLoadedAt[id];
  }

  return {
    schemaVersion: OFFLINE_CATALOG_SCHEMA_VERSION,
    userId: base.userId,
    organizationId: base.organizationId,
    updatedAt: new Date(now).toISOString(),
    sections,
    products,
    syncedScopes: Array.from(syncedScopes),
    productLoadedAt,
    scopeSyncedAt,
    pendingSyncs,
  };
}

/**
 * 1-20F — Début de la lecture serveur ayant fourni `productId` dans le
 * snapshot (ms) ; à défaut (snapshot antérieur), date d'écriture.
 */
export function snapshotProductLoadedAt(
  snapshot: OfflineCatalogSnapshot,
  productId: string,
): number | undefined {
  const own = snapshot.productLoadedAt?.[productId];
  if (typeof own === "number" && Number.isFinite(own)) return own;
  const parsed = Date.parse(snapshot.updatedAt);
  return Number.isNaN(parsed) ? undefined : parsed;
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
