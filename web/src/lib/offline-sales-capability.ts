import {
  attachVersionChangeAutoClose,
  deleteIndexedDb,
  sha256Hex,
  withTimeout,
} from "./offline-db-utils";
import { isJwtExpired } from "./jwt";

// 1-11C.3 — Capacité MINIMALE de saisie de vente hors ligne.
//
// `offlineIdentity` ne porte volontairement aucune permission. Ce snapshot
// séparé ne mémorise qu'un booléen `canRecordSales` (jamais le rôle ni la
// liste des permissions), écrit UNIQUEMENT après un `GET /auth/context`
// réussi, lié à l'identité exacte et à l'empreinte du token courant, TTL
// 72 h. Il n'autorise QUE l'affichage du formulaire et l'ajout local : le
// serveur revalide tout à la synchronisation. Purgé avec le catalogue et
// l'identité (logout/switch), jamais avec l'outbox.

export const OFFLINE_SALES_CAPABILITY_SCHEMA_VERSION = 1;
export const OFFLINE_SALES_CAPABILITY_TTL_MS = 72 * 60 * 60 * 1000;
const DB_NAME = "stockmaster-offline-sales-capability";
const DB_VERSION = 1;
const STORE_NAME = "capability";
const RECORD_KEY = "current";
const OP_TIMEOUT_MS = 2000;

export interface OfflineSalesCapability {
  schemaVersion: number;
  userId: string;
  organizationId: string;
  tokenFingerprint: string;
  canRecordSales: boolean;
  writtenAt: string;
  expiresAt: string;
}

function available(): boolean {
  return (
    typeof indexedDB !== "undefined" &&
    typeof crypto !== "undefined" &&
    typeof crypto.subtle !== "undefined"
  );
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      attachVersionChangeAutoClose(request.result);
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

// Validation PURE d'un enregistrement lu (testable sans IndexedDB).
export function isCapabilityGranted(
  record: unknown,
  expected: {
    userId: string;
    organizationId: string;
    tokenFingerprint: string;
  },
  now: number,
): boolean {
  if (!record || typeof record !== "object") return false;
  const c = record as Partial<OfflineSalesCapability>;
  if (c.schemaVersion !== OFFLINE_SALES_CAPABILITY_SCHEMA_VERSION) return false;
  if (c.userId !== expected.userId) return false;
  if (c.organizationId !== expected.organizationId) return false;
  if (c.tokenFingerprint !== expected.tokenFingerprint) return false;
  if (c.canRecordSales !== true) return false;
  const expiresAt = Date.parse(String(c.expiresAt));
  const writtenAt = Date.parse(String(c.writtenAt));
  if (Number.isNaN(expiresAt) || Number.isNaN(writtenAt)) return false;
  // TTL borné même si `expiresAt` était altéré au-delà de 72 h.
  if (expiresAt - writtenAt > OFFLINE_SALES_CAPABILITY_TTL_MS) return false;
  return now < expiresAt;
}

export async function writeSalesCapability(params: {
  userId: string;
  organizationId: string;
  token: string;
  canRecordSales: boolean;
}): Promise<boolean> {
  if (!available()) return false;
  const run = async (): Promise<boolean> => {
    const db = await openDb();
    try {
      const now = Date.now();
      const record: OfflineSalesCapability = {
        schemaVersion: OFFLINE_SALES_CAPABILITY_SCHEMA_VERSION,
        userId: params.userId,
        organizationId: params.organizationId,
        tokenFingerprint: await sha256Hex(params.token),
        canRecordSales: params.canRecordSales,
        writtenAt: new Date(now).toISOString(),
        expiresAt: new Date(
          now + OFFLINE_SALES_CAPABILITY_TTL_MS,
        ).toISOString(),
      };
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(record, RECORD_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return true;
    } finally {
      db.close();
    }
  };
  return withTimeout(run(), OP_TIMEOUT_MS, () => {
    console.warn("Offline sales capability: écriture indisponible.");
    return false;
  });
}

/** Vrai UNIQUEMENT si un snapshot valide autorise la saisie hors ligne. */
export async function readSalesCapability(params: {
  userId: string;
  organizationId: string;
  token: string | null;
}): Promise<boolean> {
  const token = params.token;
  if (!token || isJwtExpired(token) || !available()) return false;
  const run = async (): Promise<boolean> => {
    const db = await openDb();
    try {
      const record = await new Promise<unknown>((resolve, reject) => {
        const request = db
          .transaction(STORE_NAME, "readonly")
          .objectStore(STORE_NAME)
          .get(RECORD_KEY);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return isCapabilityGranted(
        record,
        {
          userId: params.userId,
          organizationId: params.organizationId,
          tokenFingerprint: await sha256Hex(token),
        },
        Date.now(),
      );
    } finally {
      db.close();
    }
  };
  return withTimeout(run(), OP_TIMEOUT_MS, () => false);
}

export function clearSalesCapability(): Promise<boolean> {
  return deleteIndexedDb(DB_NAME);
}
