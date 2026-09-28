import { attachVersionChangeAutoClose } from "./offline-db-utils";
import { readVerifiedIdentity } from "./offline-identity-db";
import {
  OUTBOX_MAX_UNFINALIZED_PER_PARTITION,
  allowedOperationActions,
  isPendingExpired,
  isSyncedPurgeable,
  isUnfinalized,
  type OutboxLastError,
  type OutboxStatus,
} from "./offline-sales-policy";

// 1-11C.2 — Outbox IndexedDB des ventes saisies hors ligne.
//
// Base SÉPARÉE du catalogue et de l'identité : `purgeAllOfflineData()` ne la
// touche JAMAIS (une vente en attente = argent encaissé ; aucune suppression
// silencieuse au logout/switch). Partition = `${userId}:${organizationId}`
// issus du contexte serveur (`GET /auth/context`) — jamais l'empreinte du
// token (sinon une simple reconnexion rendrait les ventes orphelines).
// Aucune donnée, aucun token, aucune erreur brute n'est journalisé.

export const OUTBOX_DB_NAME = "stockmaster-offline-sales-outbox";
export const OUTBOX_SCHEMA_VERSION = 1;
export const OUTBOX_CHANNEL_NAME = "stockmaster-sales-outbox";
const DB_VERSION = 1;
const OPS = "operations";
const META = "meta";
const BY_PARTITION_SEQ = "by_partition_seq";
const OPEN_TIMEOUT_MS = 2000;

export interface OutboxSalePayload {
  productId: string;
  quantity: number;
  salePrice: number;
  buyerName?: string;
  buyerContact?: string;
  occurredAt: string;
}

export interface OutboxOperation {
  schemaVersion: typeof OUTBOX_SCHEMA_VERSION;
  clientOperationId: string;
  partitionKey: string;
  userId: string;
  organizationId: string;
  seq: number;
  payload: OutboxSalePayload;
  display: { productName: string; unitPriceHint: number };
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError?: OutboxLastError;
  saleId?: string;
  createdAt: number;
  updatedAt: number;
}

export type PartitionBlockReason = "access_denied" | "corruption";

export interface OutboxPartitionMeta {
  partitionKey: string;
  nextSeq: number;
  lease?: { owner: string; expiresAt: number };
  // `access_denied` : levé automatiquement avec un AUTRE token (nouvelle
  // session) ; `corruption` : jamais levé automatiquement (1-11C.3).
  blocked?: {
    reason: PartitionBlockReason;
    tokenFingerprint?: string;
    at: number;
  };
}

export function partitionKeyOf(userId: string, organizationId: string): string {
  return `${userId}:${organizationId}`;
}

// ─── Événements (même onglet + autres onglets) ───────────────────────────────

export type OutboxEvent = "enqueued" | "updated";
const localListeners = new Set<(event: OutboxEvent) => void>();

export function notifyOutboxChanged(event: OutboxEvent): void {
  for (const listener of localListeners) listener(event);
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(OUTBOX_CHANNEL_NAME);
    channel.postMessage(event);
    channel.close();
  } catch {
    // BroadcastChannel indisponible : l'intervalle 60 s prend le relais.
  }
}

export function onOutboxChanged(
  listener: (event: OutboxEvent) => void,
): () => void {
  localListeners.add(listener);
  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(OUTBOX_CHANNEL_NAME);
      channel.onmessage = (message: MessageEvent<unknown>) => {
        if (message.data === "enqueued" || message.data === "updated") {
          listener(message.data);
        }
      };
    } catch {
      channel = null;
    }
  }
  return () => {
    localListeners.delete(listener);
    channel?.close();
  };
}

// ─── Accès IndexedDB ─────────────────────────────────────────────────────────

function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("outbox open timeout")),
      OPEN_TIMEOUT_MS,
    );
    const request = indexedDB.open(OUTBOX_DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OPS)) {
        const store = db.createObjectStore(OPS, {
          keyPath: "clientOperationId",
        });
        store.createIndex(BY_PARTITION_SEQ, ["partitionKey", "seq"], {
          unique: true,
        });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "partitionKey" });
      }
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      attachVersionChangeAutoClose(request.result);
      resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
  });
}

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Transaction unique : `body` n'attend QUE des requêtes IndexedDB (sinon la
// transaction se validerait prématurément). Résout après `oncomplete`.
async function withTx<T>(
  stores: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(stores, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("outbox tx aborted"));
    });
    let result: T;
    try {
      result = await body(tx);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // déjà terminée
      }
      await done.catch(() => undefined);
      throw error;
    }
    await done;
    return result;
  } finally {
    db.close();
  }
}

function partitionRange(partitionKey: string): IDBKeyRange {
  return IDBKeyRange.bound([partitionKey, -Infinity], [partitionKey, Infinity]);
}

function getPartitionOps(
  tx: IDBTransaction,
  partitionKey: string,
): Promise<OutboxOperation[]> {
  return req(
    tx
      .objectStore(OPS)
      .index(BY_PARTITION_SEQ)
      .getAll(partitionRange(partitionKey)) as IDBRequest<OutboxOperation[]>,
  );
}

async function getMetaIn(
  tx: IDBTransaction,
  partitionKey: string,
): Promise<OutboxPartitionMeta> {
  const meta = (await req(tx.objectStore(META).get(partitionKey))) as
    OutboxPartitionMeta | undefined;
  return meta ?? { partitionKey, nextSeq: 1 };
}

// ─── Ajout (vérifié) ─────────────────────────────────────────────────────────

export type EnqueueResult =
  | { ok: true; clientOperationId: string }
  | {
      ok: false;
      reason:
        "identity" | "invalid" | "limit" | "unavailable" | "not-replaceable";
    };

const OBJECT_ID = /^[0-9a-f]{24}$/i;

function isValidPayload(p: Omit<OutboxSalePayload, "occurredAt">): boolean {
  const text = (v: unknown) =>
    v === undefined || (typeof v === "string" && v.length <= 100);
  return (
    typeof p.productId === "string" &&
    OBJECT_ID.test(p.productId) &&
    Number.isInteger(p.quantity) &&
    p.quantity >= 1 &&
    typeof p.salePrice === "number" &&
    Number.isFinite(p.salePrice) &&
    p.salePrice >= 0 &&
    text(p.buyerName) &&
    text(p.buyerContact)
  );
}

async function verifiedPartition(params: {
  userId: string;
  organizationId: string;
  token: string | null;
}): Promise<string | null> {
  const identity = await readVerifiedIdentity({ token: params.token });
  if (
    !identity ||
    identity.userId !== params.userId ||
    identity.organizationId !== params.organizationId
  ) {
    return null;
  }
  return partitionKeyOf(params.userId, params.organizationId);
}

let persistRequested = false;

function requestPersistentStorage(): void {
  if (persistRequested) return;
  persistRequested = true;
  try {
    void navigator.storage?.persist?.().catch(() => undefined);
  } catch {
    // best effort
  }
}

/**
 * Ajoute une vente à la partition `${userId}:${organizationId}` (contexte
 * serveur), après vérification de l'identité locale liée au token courant.
 * `clientOperationId` et `occurredAt` (heure réelle UTC) sont figés ICI, une
 * seule fois. Au-delà de 200 opérations non finalisées : refus, jamais
 * d'éviction.
 *
 * 1-11C.3 — `replaces` : correction d'un conflit. La NOUVELLE opération
 * (nouvel UUID) est ajoutée et l'ancienne passe `abandoned` dans la MÊME
 * transaction : jamais d'abandon sans remplaçant, jamais de réutilisation de
 * l'ancienne clé. Refusé si l'ancienne n'est pas éditable
 * (`allowedOperationActions`).
 */
export async function enqueueOfflineSale(params: {
  userId: string;
  organizationId: string;
  token: string | null;
  payload: Omit<OutboxSalePayload, "occurredAt">;
  display: { productName: string; unitPriceHint: number };
  replaces?: string;
  now?: number;
}): Promise<EnqueueResult> {
  if (!isIndexedDbAvailable() || typeof crypto?.randomUUID !== "function") {
    return { ok: false, reason: "unavailable" };
  }
  if (!isValidPayload(params.payload)) return { ok: false, reason: "invalid" };
  const partitionKey = await verifiedPartition(params);
  if (!partitionKey) return { ok: false, reason: "identity" };

  const now = params.now ?? Date.now();
  const clientOperationId = crypto.randomUUID();
  const { productId, quantity, salePrice, buyerName, buyerContact } =
    params.payload;
  try {
    const outcome = await withTx([OPS, META], "readwrite", async (tx) => {
      const ops = await getPartitionOps(tx, partitionKey);
      const replaced = params.replaces
        ? ops.find((op) => op.clientOperationId === params.replaces)
        : undefined;
      if (
        params.replaces &&
        (!replaced || !allowedOperationActions(replaced).edit)
      ) {
        return "not-replaceable" as const;
      }
      const unfinalized = ops.filter(
        (op) => isUnfinalized(op.status) && op !== replaced,
      ).length;
      if (unfinalized >= OUTBOX_MAX_UNFINALIZED_PER_PARTITION) {
        return "limit" as const;
      }
      const meta = await getMetaIn(tx, partitionKey);
      const operation: OutboxOperation = {
        schemaVersion: OUTBOX_SCHEMA_VERSION,
        clientOperationId,
        partitionKey,
        userId: params.userId,
        organizationId: params.organizationId,
        seq: meta.nextSeq,
        payload: {
          productId: productId.toLowerCase(),
          quantity,
          salePrice,
          ...(buyerName !== undefined ? { buyerName } : {}),
          ...(buyerContact !== undefined ? { buyerContact } : {}),
          occurredAt: new Date(now).toISOString(),
        },
        display: {
          productName: params.display.productName,
          unitPriceHint: params.display.unitPriceHint,
        },
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      };
      await req(tx.objectStore(OPS).add(operation));
      if (replaced) {
        await req(
          tx
            .objectStore(OPS)
            .put({ ...replaced, status: "abandoned", updatedAt: now }),
        );
      }
      await req(
        tx.objectStore(META).put({ ...meta, nextSeq: meta.nextSeq + 1 }),
      );
      return "added" as const;
    });
    if (outcome !== "added") return { ok: false, reason: outcome };
  } catch {
    console.warn("Offline sales outbox: ajout indisponible.");
    return { ok: false, reason: "unavailable" };
  }
  requestPersistentStorage();
  notifyOutboxChanged("enqueued");
  return { ok: true, clientOperationId };
}

/** Lecture vérifiée d'une partition (FIFO) — interface et stock indicatif. */
export async function readPartitionOperations(params: {
  userId: string;
  organizationId: string;
  token: string | null;
}): Promise<OutboxOperation[] | null> {
  if (!isIndexedDbAvailable()) return null;
  const partitionKey = await verifiedPartition(params);
  if (!partitionKey) return null;
  try {
    return await withTx([OPS], "readonly", (tx) =>
      getPartitionOps(tx, partitionKey),
    );
  } catch {
    console.warn("Offline sales outbox: lecture indisponible.");
    return null;
  }
}

// ─── Primitives du moteur (appelées APRÈS vérification par le worker) ────────

/** Faux si la base n'a jamais été créée (évite de la créer pour rien). */
export async function outboxDatabaseMayExist(): Promise<boolean> {
  if (!isIndexedDbAvailable()) return false;
  if (typeof indexedDB.databases !== "function") return true;
  try {
    const dbs = await indexedDB.databases();
    return dbs.some((db) => db.name === OUTBOX_DB_NAME);
  } catch {
    return true;
  }
}

/** Nombre d'opérations à envoyer (pending/syncing) de la partition. */
export async function countSendable(partitionKey: string): Promise<number> {
  const ops = await withTx([OPS], "readonly", (tx) =>
    getPartitionOps(tx, partitionKey),
  );
  return ops.filter((op) => op.status === "pending" || op.status === "syncing")
    .length;
}

/**
 * Préparation sous verrou, une transaction, PARTITION COURANTE uniquement :
 * `syncing` → `pending` (reprise après crash d'onglet), `pending` > 14 j →
 * `conflict EXPIRED` (jamais envoyé), `synced` > 7 j → supprimé.
 */
export async function preparePartition(
  partitionKey: string,
  now: number,
): Promise<void> {
  const changed = await withTx([OPS], "readwrite", async (tx) => {
    const store = tx.objectStore(OPS);
    let count = 0;
    for (const op of await getPartitionOps(tx, partitionKey)) {
      if (op.status === "synced" && isSyncedPurgeable(op.updatedAt, now)) {
        await req(store.delete(op.clientOperationId));
        count++;
        continue;
      }
      let next = op;
      if (op.status === "syncing") next = { ...next, status: "pending" };
      if (next.status === "pending" && isPendingExpired(op.createdAt, now)) {
        next = {
          ...next,
          status: "conflict",
          lastError: { kind: "business", code: "EXPIRED" },
        };
      }
      if (next !== op) {
        await req(store.put({ ...next, updatedAt: now }));
        count++;
      }
    }
    return count;
  });
  if (changed > 0) notifyOutboxChanged("updated");
}

/** Première opération `pending` (plus petit `seq`) de la partition. */
export async function getHeadPending(
  partitionKey: string,
): Promise<OutboxOperation | null> {
  const ops = await withTx([OPS], "readonly", (tx) =>
    getPartitionOps(tx, partitionKey),
  );
  return ops.find((op) => op.status === "pending") ?? null;
}

/**
 * Mise à jour conditionnelle : n'écrit que si l'opération existe toujours
 * dans la MÊME partition. Renvoie faux sinon (supprimée/altérée entre-temps).
 */
export async function updateOperation(
  clientOperationId: string,
  partitionKey: string,
  patch: Partial<
    Pick<
      OutboxOperation,
      "status" | "attempts" | "nextAttemptAt" | "lastError" | "saleId"
    >
  >,
  now: number,
): Promise<boolean> {
  const ok = await withTx([OPS], "readwrite", async (tx) => {
    const store = tx.objectStore(OPS);
    const current = (await req(store.get(clientOperationId))) as
      OutboxOperation | undefined;
    if (!current || current.partitionKey !== partitionKey) return false;
    const next: OutboxOperation = { ...current, ...patch, updatedAt: now };
    // `lastError: undefined` explicite → effacée (sinon conservée).
    if ("lastError" in patch && patch.lastError === undefined) {
      delete next.lastError;
    }
    await req(store.put(next));
    return true;
  });
  if (ok) notifyOutboxChanged("updated");
  return ok;
}

export async function getPartitionMeta(
  partitionKey: string,
): Promise<OutboxPartitionMeta> {
  return withTx([META], "readonly", (tx) => getMetaIn(tx, partitionKey));
}

export async function setPartitionBlocked(
  partitionKey: string,
  blocked: OutboxPartitionMeta["blocked"] | null,
): Promise<void> {
  await withTx([META], "readwrite", async (tx) => {
    const meta = await getMetaIn(tx, partitionKey);
    const next: OutboxPartitionMeta = { ...meta };
    if (blocked) next.blocked = blocked;
    else delete next.blocked;
    await req(tx.objectStore(META).put(next));
  });
  notifyOutboxChanged("updated");
}

// ─── Bail de secours (sans Web Locks) ────────────────────────────────────────

/**
 * Acquisition TRANSACTIONNELLE : réussit si aucun bail, bail expiré, ou bail
 * déjà détenu par `owner`. Utilisé aussi pour le renouvellement (même règle :
 * échoue si un autre onglet l'a repris après expiration).
 */
export async function tryAcquireLease(
  partitionKey: string,
  owner: string,
  now: number,
  durationMs: number,
): Promise<boolean> {
  return withTx([META], "readwrite", async (tx) => {
    const meta = await getMetaIn(tx, partitionKey);
    if (
      meta.lease &&
      meta.lease.owner !== owner &&
      meta.lease.expiresAt > now
    ) {
      return false;
    }
    await req(
      tx
        .objectStore(META)
        .put({ ...meta, lease: { owner, expiresAt: now + durationMs } }),
    );
    return true;
  });
}

export async function releaseLease(
  partitionKey: string,
  owner: string,
): Promise<void> {
  await withTx([META], "readwrite", async (tx) => {
    const meta = await getMetaIn(tx, partitionKey);
    if (meta.lease?.owner !== owner) return;
    const next: OutboxPartitionMeta = { ...meta };
    delete next.lease;
    await req(tx.objectStore(META).put(next));
  });
}

// ─── Actions utilisateur vérifiées (1-11C.3) ─────────────────────────────────

export interface PartitionState {
  operations: OutboxOperation[];
  blocked: OutboxPartitionMeta["blocked"] | null;
}

/** Opérations + blocage de la partition, après vérification d'identité. */
export async function readPartitionState(params: {
  userId: string;
  organizationId: string;
  token: string | null;
}): Promise<PartitionState | null> {
  if (!isIndexedDbAvailable()) return null;
  const partitionKey = await verifiedPartition(params);
  if (!partitionKey) return null;
  if (!(await outboxDatabaseMayExist())) {
    return { operations: [], blocked: null };
  }
  try {
    return await withTx([OPS, META], "readonly", async (tx) => ({
      operations: await getPartitionOps(tx, partitionKey),
      blocked: (await getMetaIn(tx, partitionKey)).blocked ?? null,
    }));
  } catch {
    console.warn("Offline sales outbox: lecture indisponible.");
    return null;
  }
}

export type OperationAction =
  "sync-now" | "retry" | "abandon" | "remove-corrupted";

/**
 * Action explicite de l'utilisateur sur UNE opération de SA partition,
 * autorisée par `allowedOperationActions` :
 * - `sync-now` : pending → échéance immédiate (même UUID) ;
 * - `retry` : conflit SERVER_UNAVAILABLE → pending, compteur remis à zéro
 *   (même UUID : le serveur dédoublonne) ;
 * - `abandon` : conflit → abandoned (confirmé par l'utilisateur) ;
 * - `remove-corrupted` : conflit d'idempotence → abandoned ET levée du
 *   blocage de partition (après export, confirmé par l'utilisateur).
 * Rien n'est jamais supprimé physiquement ici.
 */
export async function applyOperationAction(
  params: { userId: string; organizationId: string; token: string | null },
  clientOperationId: string,
  action: OperationAction,
  now: number = Date.now(),
): Promise<boolean> {
  const partitionKey = await verifiedPartition(params);
  if (!partitionKey) return false;
  try {
    const ok = await withTx([OPS, META], "readwrite", async (tx) => {
      const store = tx.objectStore(OPS);
      const op = (await req(store.get(clientOperationId))) as
        OutboxOperation | undefined;
      if (!op || op.partitionKey !== partitionKey) return false;
      const allowed = allowedOperationActions(op);
      let next: OutboxOperation;
      switch (action) {
        case "sync-now":
          if (!allowed.syncNow) return false;
          next = { ...op, nextAttemptAt: now };
          break;
        case "retry":
          if (!allowed.retry) return false;
          next = { ...op, status: "pending", attempts: 0, nextAttemptAt: now };
          delete next.lastError;
          break;
        case "abandon":
          if (!allowed.abandon) return false;
          next = { ...op, status: "abandoned" };
          break;
        case "remove-corrupted": {
          if (!allowed.removeCorrupted) return false;
          next = { ...op, status: "abandoned" };
          const meta = await getMetaIn(tx, partitionKey);
          if (meta.blocked?.reason === "corruption") {
            const unblocked: OutboxPartitionMeta = { ...meta };
            delete unblocked.blocked;
            await req(tx.objectStore(META).put(unblocked));
          }
          break;
        }
      }
      await req(store.put({ ...next, updatedAt: now }));
      return true;
    });
    if (ok) notifyOutboxChanged(action === "abandon" ? "updated" : "enqueued");
    return ok;
  } catch {
    console.warn("Offline sales outbox: action indisponible.");
    return false;
  }
}

// ─── Logout : toutes les partitions de l'utilisateur courant ─────────────────

const USER_SCAN_TIMEOUT_MS = 3000;

function withRejectTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Opérations NON finalisées de toutes les partitions de `userId` (plusieurs
 * organisations possibles). `null` = lecture impossible (timeout/erreur) :
 * l'appelant ne supprime alors RIEN.
 */
export async function readUserUnfinalizedOperations(
  userId: string,
): Promise<OutboxOperation[] | null> {
  if (!isIndexedDbAvailable()) return null;
  try {
    if (!(await outboxDatabaseMayExist())) return [];
    const all = await withRejectTimeout(
      withTx([OPS], "readonly", (tx) =>
        req(tx.objectStore(OPS).getAll() as IDBRequest<OutboxOperation[]>),
      ),
      USER_SCAN_TIMEOUT_MS,
    );
    return all
      .filter((op) => op.userId === userId && isUnfinalized(op.status))
      .sort((a, b) =>
        a.partitionKey === b.partitionKey
          ? a.seq - b.seq
          : a.partitionKey.localeCompare(b.partitionKey),
      );
  } catch {
    return null;
  }
}

/**
 * Suppression DÉFINITIVE, uniquement sur double confirmation explicite au
 * logout : toutes les opérations de `userId` (toutes partitions) et leurs
 * métadonnées. Jamais appelée par défaut.
 */
export async function deleteUserOperations(userId: string): Promise<boolean> {
  if (!isIndexedDbAvailable()) return false;
  try {
    await withRejectTimeout(
      withTx([OPS, META], "readwrite", async (tx) => {
        const store = tx.objectStore(OPS);
        const all = (await req(store.getAll())) as OutboxOperation[];
        const partitions = new Set<string>();
        for (const op of all) {
          if (op.userId !== userId) continue;
          partitions.add(op.partitionKey);
          await req(store.delete(op.clientOperationId));
        }
        for (const key of partitions) {
          await req(tx.objectStore(META).delete(key));
        }
      }),
      USER_SCAN_TIMEOUT_MS,
    );
    notifyOutboxChanged("updated");
    return true;
  } catch {
    return false;
  }
}

/** « Synchroniser maintenant » : toutes les pending de la partition à échéance immédiate. */
export async function expeditePartition(
  params: { userId: string; organizationId: string; token: string | null },
  now: number = Date.now(),
): Promise<boolean> {
  const partitionKey = await verifiedPartition(params);
  if (!partitionKey) return false;
  try {
    await withTx([OPS], "readwrite", async (tx) => {
      for (const op of await getPartitionOps(tx, partitionKey)) {
        if (op.status === "pending" && op.nextAttemptAt > now) {
          await req(
            tx
              .objectStore(OPS)
              .put({ ...op, nextAttemptAt: now, updatedAt: now }),
          );
        }
      }
    });
    notifyOutboxChanged("enqueued");
    return true;
  } catch {
    return false;
  }
}
