// Pointeur d'identité hors ligne (1-11B) : jamais de token brut, payload
// JWT, rôle ou permission — uniquement un détecteur LOCAL de changement de
// session. Le fingerprint ne prouve qu'une absence de changement du token
// stocké localement ; il ne constitue JAMAIS une validation cryptographique
// serveur (aucune vérification de signature/révocation possible hors ligne).
import {
  withTimeout,
  attachVersionChangeAutoClose,
  deleteIndexedDb,
} from "./offline-db-utils";
import { isJwtExpired } from "./jwt";

export const OFFLINE_IDENTITY_SCHEMA_VERSION = 1;

const DB_NAME = "stockmaster-offline-identity";
const DB_VERSION = 1;
const STORE_NAME = "identity";
const RECORD_KEY = "current";
const OP_TIMEOUT_MS = 2000;

export interface OfflineIdentityPointer {
  schemaVersion: number;
  userId: string;
  organizationId: string;
  tokenFingerprint: string;
  writtenAt: string;
}

function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function hasWebCrypto(): boolean {
  return typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined";
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
  console.warn(`Offline identity: ${action} indisponible.`);
}

// Écrit uniquement APRÈS un GET /auth/context réussi — userId/organizationId
// proviennent exclusivement de cette réponse authentifiée (jamais body/
// query/header/saisie libre), fournis par l'appelant.
export async function writeIdentityPointer(params: {
  userId: string;
  organizationId: string;
  token: string;
}): Promise<boolean> {
  if (!isIndexedDbAvailable() || !hasWebCrypto()) return false;
  const run = async (): Promise<boolean> => {
    let db: IDBDatabase;
    try {
      db = await openDb();
    } catch {
      warnGeneric("ouverture");
      return false;
    }
    try {
      const tokenFingerprint = await sha256Hex(params.token);
      const pointer: OfflineIdentityPointer = {
        schemaVersion: OFFLINE_IDENTITY_SCHEMA_VERSION,
        userId: params.userId,
        organizationId: params.organizationId,
        tokenFingerprint,
        writtenAt: new Date().toISOString(),
      };
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(pointer, RECORD_KEY);
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

// Lecture stricte : le token COURANT (déjà en localStorage, jamais persisté
// ici) doit produire EXACTEMENT le même hash que celui écrit avec le
// pointeur, et ne doit pas être expiré localement — sinon aucune identité
// n'est retournée (fail-closed). Jamais de recherche approximative.
export async function readVerifiedIdentity(params: {
  token: string | null;
}): Promise<{ userId: string; organizationId: string } | null> {
  if (!params.token || isJwtExpired(params.token)) return null;
  if (!isIndexedDbAvailable() || !hasWebCrypto()) return null;
  const token = params.token;
  const run = async (): Promise<{
    userId: string;
    organizationId: string;
  } | null> => {
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
        const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (!record || typeof record !== "object") return null;
      const pointer = record as Partial<OfflineIdentityPointer>;
      if (pointer.schemaVersion !== OFFLINE_IDENTITY_SCHEMA_VERSION)
        return null;
      if (
        typeof pointer.userId !== "string" ||
        typeof pointer.organizationId !== "string"
      ) {
        return null;
      }
      if (typeof pointer.tokenFingerprint !== "string") return null;
      const currentFingerprint = await sha256Hex(token);
      if (currentFingerprint !== pointer.tokenFingerprint) return null;
      return { userId: pointer.userId, organizationId: pointer.organizationId };
    } catch {
      warnGeneric("lecture");
      return null;
    } finally {
      db.close();
    }
  };
  return withTimeout(run(), OP_TIMEOUT_MS, () => null);
}

export async function clearOfflineIdentity(): Promise<boolean> {
  return deleteIndexedDb(DB_NAME);
}
