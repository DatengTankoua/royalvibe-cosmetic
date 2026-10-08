import {
  attachVersionChangeAutoClose,
  deleteIndexedDb,
  withTimeout,
} from "./offline-db-utils";
import { normalizeBrandColor } from "./tenant-brand";

// 1-12A — Identité visuelle MINIMALE du commerce pour un rechargement hors
// ligne : nom + couleur, rien d'autre (jamais de rôle, permission, JWT,
// empreinte de token, membership, logo ni réponse API brute — chaque champ
// est recopié explicitement). Écrite UNIQUEMENT après succès de
// `/auth/context` ET `/organizations/current` pour la même organisation ;
// lue UNIQUEMENT après validation de l'identité locale courante
// (`readVerifiedIdentity`), avec correspondance exacte user/organisation et
// TTL 72 h. Purgée avec catalogue/identité/capacité (`purgeAllOfflineData`),
// à chaque login réussi et sur refus serveur du contexte.

export const OFFLINE_TENANT_BRAND_SCHEMA_VERSION = 1;
export const OFFLINE_TENANT_BRAND_TTL_MS = 72 * 60 * 60 * 1000;
// Borne défensive de lecture (la limite métier du nom viendra côté API).
const MAX_STORED_NAME_LENGTH = 200;
// Tolérance d'horloge : un `updatedAt` dans le futur au-delà est refusé.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const DB_NAME = "stockmaster-offline-tenant-brand";
const DB_VERSION = 1;
const STORE_NAME = "brand";
const RECORD_KEY = "current";
const OP_TIMEOUT_MS = 2000;

export interface OfflineTenantBrand {
  schemaVersion: number;
  userId: string;
  organizationId: string;
  organizationName: string;
  brandColor: string;
  updatedAt: string;
}

export interface TenantBrandSnapshot {
  organizationName: string;
  brandColor: string;
}

function available(): boolean {
  return typeof indexedDB !== "undefined";
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
export function validateTenantBrandRecord(
  record: unknown,
  expected: { userId: string; organizationId: string },
  now: number,
): TenantBrandSnapshot | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Partial<OfflineTenantBrand>;
  if (r.schemaVersion !== OFFLINE_TENANT_BRAND_SCHEMA_VERSION) return null;
  if (r.userId !== expected.userId) return null;
  if (r.organizationId !== expected.organizationId) return null;
  if (
    typeof r.organizationName !== "string" ||
    r.organizationName.trim().length === 0 ||
    r.organizationName.length > MAX_STORED_NAME_LENGTH
  ) {
    return null;
  }
  const brandColor = normalizeBrandColor(r.brandColor);
  if (!brandColor) return null;
  const updatedAt = Date.parse(String(r.updatedAt));
  if (Number.isNaN(updatedAt)) return null;
  if (updatedAt > now + CLOCK_SKEW_MS) return null;
  if (now - updatedAt >= OFFLINE_TENANT_BRAND_TTL_MS) return null;
  return { organizationName: r.organizationName, brandColor };
}

export async function writeTenantBrand(params: {
  userId: string;
  organizationId: string;
  organizationName: string;
  brandColor: string;
}): Promise<boolean> {
  const brandColor = normalizeBrandColor(params.brandColor);
  const organizationName = params.organizationName.slice(
    0,
    MAX_STORED_NAME_LENGTH,
  );
  if (!available() || !brandColor || !organizationName.trim()) return false;
  const run = async (): Promise<boolean> => {
    const db = await openDb();
    try {
      const record: OfflineTenantBrand = {
        schemaVersion: OFFLINE_TENANT_BRAND_SCHEMA_VERSION,
        userId: params.userId,
        organizationId: params.organizationId,
        organizationName,
        brandColor,
        updatedAt: new Date().toISOString(),
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
    console.warn("Offline tenant brand: écriture indisponible.");
    return false;
  });
}

/**
 * `identity` DOIT provenir de `readVerifiedIdentity` (empreinte du token
 * courant déjà vérifiée) : jamais d'identifiants issus d'une autre source.
 */
export async function readTenantBrand(identity: {
  userId: string;
  organizationId: string;
}): Promise<TenantBrandSnapshot | null> {
  if (!available()) return null;
  const run = async (): Promise<TenantBrandSnapshot | null> => {
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
      return validateTenantBrandRecord(record, identity, Date.now());
    } finally {
      db.close();
    }
  };
  return withTimeout(run(), OP_TIMEOUT_MS, () => null);
}

export function clearTenantBrand(): Promise<boolean> {
  return deleteIndexedDb(DB_NAME);
}
