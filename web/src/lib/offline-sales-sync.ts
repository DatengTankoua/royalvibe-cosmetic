import {
  createSaleIdempotent,
  isCommercialRefusalCode,
  setForcedLogoutListener,
  toSaleSyncOutcome,
} from "./api";
import { getToken } from "./auth";
import { isJwtExpired } from "./jwt";
import { sha256Hex } from "./offline-db-utils";
import { readVerifiedIdentity } from "./offline-identity-db";
import {
  OUTBOX_SCHEMA_VERSION,
  countSendable,
  getHeadPending,
  getPartitionMeta,
  outboxDatabaseMayExist,
  partitionKeyOf,
  preparePartition,
  releaseLease,
  setPartitionBlocked,
  tryAcquireLease,
  updateOperation,
  type OutboxOperation,
} from "./offline-sales-outbox-db";
import {
  OUTBOX_MAX_SERVER_ATTEMPTS,
  classifySaleSyncOutcome,
  computeRetryDelayMs,
} from "./offline-sales-policy";

// 1-11C.2 — Moteur de synchronisation de l'outbox des ventes.
//
// Une passe = UNE partition (`${userId}:${organizationId}` du contexte
// serveur), avec token, userId, organizationId et partition capturés UNE
// fois. Toute divergence (token local changé, identité locale différente,
// opération d'une autre partition) arrête la passe : aucune opération de A
// n'est jamais envoyée avec un JWT B. Un seul worker par partition (Web
// Locks, sinon bail IndexedDB 30 s). Aucun Background Sync, aucun service
// worker : uniquement pendant que le shell /app est ouvert et en ligne.

export const SALES_SYNC_LOCK_PREFIX = "stockmaster-sales-sync:";
const LEASE_DURATION_MS = 30_000;
const LEASE_RENEW_MS = 10_000;
const TOKEN_STORAGE_KEY = "heyama_token";

// Identifiant d'onglet pour le bail de secours (jamais persisté ailleurs).
const TAB_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

export type SyncPassResult =
  | { status: "skipped"; reason: SkipReason }
  | { status: "idle" }
  | { status: "locked" }
  | { status: "blocked" }
  | { status: "completed"; nextDueAt?: number }
  | { status: "stopped"; reason: StopReason; nextDueAt?: number };

type SkipReason =
  "stopped" | "offline" | "no-session" | "identity" | "unavailable";
type StopReason =
  | "aborted"
  | "token-changed"
  | "auth"
  | "access-denied"
  | "subscription"
  | "corruption"
  | "lease-lost"
  | "error";

// ─── État de module : passe en cours et arrêt demandé ────────────────────────

let currentController: AbortController | null = null;
let currentPass: Promise<SyncPassResult> | null = null;
let stopped = false;

/**
 * Arrête la synchronisation (1-11C.3 : avant logout/switch) : annule la passe
 * en cours et attend sa fin au plus `timeoutMs` — ne bloque jamais au-delà.
 * Aucune nouvelle passe tant que `resumeOfflineSalesSync()` n'est pas appelé.
 * Ne supprime JAMAIS l'outbox.
 */
export async function stopOfflineSalesSync(timeoutMs: number): Promise<void> {
  stopped = true;
  currentController?.abort();
  const pass = currentPass;
  if (!pass) return;
  await Promise.race([
    pass.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

// 1-11C.3 : déconnexion forcée (401 du token courant) → arrêt immédiat,
// outbox conservée.
setForcedLogoutListener(() => {
  stopped = true;
  currentController?.abort();
});

export function resumeOfflineSalesSync(): void {
  stopped = false;
}

/** Annule la passe en cours sans bloquer les suivantes (token changé). */
export function abortCurrentOfflineSalesSync(): void {
  currentController?.abort();
}

// Demande locale de passe (même onglet), p. ex. une fois le pointeur
// d'identité écrit par le shell : sans lui, `readVerifiedIdentity` échoue.
const syncRequestListeners = new Set<() => void>();

export function requestOfflineSalesSync(): void {
  for (const listener of syncRequestListeners) listener();
}

export function onOfflineSalesSyncRequested(listener: () => void): () => void {
  syncRequestListeners.add(listener);
  return () => {
    syncRequestListeners.delete(listener);
  };
}

export function isAuthTokenStorageKey(key: string | null): boolean {
  // `null` = `localStorage.clear()` dans un autre onglet.
  return key === null || key === TOKEN_STORAGE_KEY;
}

// ─── Point d'entrée ──────────────────────────────────────────────────────────

/**
 * Lance une passe pour la partition du contexte serveur `authContext`.
 * Coalescée : si une passe tourne déjà dans cet onglet, renvoie la même.
 */
export function runOfflineSalesSync(authContext: {
  userId: string;
  organizationId: string;
}): Promise<SyncPassResult> {
  if (currentPass) return currentPass;
  const controller = new AbortController();
  currentController = controller;
  const pass = runPass(authContext, controller.signal)
    .catch((): SyncPassResult => {
      console.warn("Offline sales sync: passe interrompue.");
      return { status: "stopped", reason: "error" };
    })
    .finally(() => {
      if (currentController === controller) currentController = null;
      currentPass = null;
    });
  currentPass = pass;
  return pass;
}

async function runPass(
  authContext: { userId: string; organizationId: string },
  signal: AbortSignal,
): Promise<SyncPassResult> {
  if (stopped) return { status: "skipped", reason: "stopped" };
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return { status: "skipped", reason: "offline" };
  }
  // Capture UNIQUE pour toute la passe.
  const token = getToken();
  if (!token || isJwtExpired(token)) {
    return { status: "skipped", reason: "no-session" };
  }
  const identity = await readVerifiedIdentity({ token });
  if (
    !identity ||
    identity.userId !== authContext.userId ||
    identity.organizationId !== authContext.organizationId
  ) {
    return { status: "skipped", reason: "identity" };
  }
  const session: CapturedSession = {
    token,
    userId: authContext.userId,
    organizationId: authContext.organizationId,
    partitionKey: partitionKeyOf(
      authContext.userId,
      authContext.organizationId,
    ),
    signal,
  };

  // Inactif si la file est vide : aucune base créée, aucun verrou, aucun réseau.
  if (!(await outboxDatabaseMayExist())) return { status: "idle" };
  try {
    if ((await countSendable(session.partitionKey)) === 0) {
      return { status: "idle" };
    }
  } catch {
    return { status: "skipped", reason: "unavailable" };
  }

  return withPartitionLock(session.partitionKey, signal, (leaseSignal) =>
    processPartition(session, leaseSignal),
  );
}

interface CapturedSession {
  token: string;
  userId: string;
  organizationId: string;
  partitionKey: string;
  signal: AbortSignal;
}

// ─── Verrou : Web Locks, sinon bail IndexedDB ────────────────────────────────

async function withPartitionLock(
  partitionKey: string,
  signal: AbortSignal,
  body: (signal: AbortSignal) => Promise<SyncPassResult>,
): Promise<SyncPassResult> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks && typeof locks.request === "function") {
    return locks.request(
      `${SALES_SYNC_LOCK_PREFIX}${partitionKey}`,
      { ifAvailable: true },
      async (lock) => (lock ? body(signal) : { status: "locked" as const }),
    );
  }
  return withLeaseFallback(partitionKey, signal, body);
}

async function withLeaseFallback(
  partitionKey: string,
  signal: AbortSignal,
  body: (signal: AbortSignal) => Promise<SyncPassResult>,
): Promise<SyncPassResult> {
  if (
    !(await tryAcquireLease(
      partitionKey,
      TAB_ID,
      Date.now(),
      LEASE_DURATION_MS,
    ))
  ) {
    return { status: "locked" };
  }
  // Bail perdu (repris par un autre onglet après expiration) → arrêt.
  const leaseController = new AbortController();
  const onAbort = () => leaseController.abort();
  signal.addEventListener("abort", onAbort);
  let leaseLost = false;
  const timer = setInterval(() => {
    void tryAcquireLease(partitionKey, TAB_ID, Date.now(), LEASE_DURATION_MS)
      .then((renewed) => {
        if (!renewed) {
          leaseLost = true;
          leaseController.abort();
        }
      })
      .catch(() => {
        leaseLost = true;
        leaseController.abort();
      });
  }, LEASE_RENEW_MS);
  try {
    const result = await body(leaseController.signal);
    return leaseLost ? { status: "stopped", reason: "lease-lost" } : result;
  } finally {
    clearInterval(timer);
    signal.removeEventListener("abort", onAbort);
    await releaseLease(partitionKey, TAB_ID).catch(() => undefined);
  }
}

// ─── Traitement FIFO d'une partition ─────────────────────────────────────────

function belongsToSession(op: OutboxOperation, s: CapturedSession): boolean {
  return (
    op.schemaVersion === OUTBOX_SCHEMA_VERSION &&
    op.partitionKey === s.partitionKey &&
    op.userId === s.userId &&
    op.organizationId === s.organizationId
  );
}

async function processPartition(
  s: CapturedSession,
  signal: AbortSignal,
): Promise<SyncPassResult> {
  const fingerprint = await sha256Hex(s.token);
  const meta = await getPartitionMeta(s.partitionKey);
  if (meta.blocked) {
    // Refus d'accès levé seulement par une NOUVELLE session (autre token) ;
    // corruption jamais levée automatiquement ; refus COMMERCIAL (1-14C.2)
    // levé seulement par `clearSubscriptionBlock` (signal serveur explicite),
    // jamais par un changement de token.
    if (
      meta.blocked.reason === "corruption" ||
      meta.blocked.reason === "subscription" ||
      meta.blocked.tokenFingerprint === fingerprint
    ) {
      return { status: "blocked" };
    }
    await setPartitionBlocked(s.partitionKey, null);
  }

  await preparePartition(s.partitionKey, Date.now());

  for (;;) {
    const guard = sessionGuard(s, signal);
    if (guard) return { status: "stopped", reason: guard };

    const op = await getHeadPending(s.partitionKey);
    if (!op) return { status: "completed" };
    if (!belongsToSession(op, s)) {
      await updateOperation(
        op.clientOperationId,
        op.partitionKey,
        {
          status: "conflict",
          lastError: { kind: "corruption", code: "PARTITION_MISMATCH" },
        },
        Date.now(),
      );
      await setPartitionBlocked(s.partitionKey, {
        reason: "corruption",
        at: Date.now(),
      });
      return { status: "stopped", reason: "corruption" };
    }
    // FIFO strict : la tête de file en attente de backoff bloque la suite.
    if (op.nextAttemptAt > Date.now()) {
      return { status: "completed", nextDueAt: op.nextAttemptAt };
    }

    await updateOperation(
      op.clientOperationId,
      s.partitionKey,
      { status: "syncing" },
      Date.now(),
    );
    // Revérification juste avant l'envoi : jamais un token différent.
    const late = sessionGuard(s, signal);
    if (late) {
      await updateOperation(
        op.clientOperationId,
        s.partitionKey,
        { status: "pending" },
        Date.now(),
      );
      return { status: "stopped", reason: late };
    }

    let outcome;
    try {
      const sale = await createSaleIdempotent(
        op.payload,
        op.clientOperationId,
        s.token,
        signal,
      );
      outcome = { kind: "success" as const, saleId: String(sale._id) };
    } catch (error) {
      outcome = signal.aborted
        ? { kind: "aborted" as const }
        : toSaleSyncOutcome(error);
    }

    const next = await applyDecision(s, op, outcome, fingerprint);
    if (next) return next;
  }
}

function sessionGuard(
  s: CapturedSession,
  signal: AbortSignal,
): StopReason | null {
  if (getToken() !== s.token) return "token-changed";
  if (signal.aborted) return "aborted";
  return null;
}

// Applique la matrice ; renvoie un résultat pour arrêter, `null` pour continuer.
async function applyDecision(
  s: CapturedSession,
  op: OutboxOperation,
  outcome: Parameters<typeof classifySaleSyncOutcome>[0],
  fingerprint: string,
): Promise<SyncPassResult | null> {
  const now = Date.now();
  const decision = classifySaleSyncOutcome(outcome);
  const update = (patch: Parameters<typeof updateOperation>[2]) =>
    updateOperation(op.clientOperationId, s.partitionKey, patch, now);

  switch (decision.action) {
    case "synced":
      await update({
        status: "synced",
        ...(outcome.kind === "success" ? { saleId: outcome.saleId } : {}),
        lastError: decision.code
          ? { kind: "business", code: decision.code, httpStatus: 409 }
          : undefined,
      });
      return null;
    case "conflict":
      await update({ status: "conflict", lastError: decision.error });
      return null;
    case "conflict-block":
      await update({ status: "conflict", lastError: decision.error });
      await setPartitionBlocked(s.partitionKey, {
        reason: "corruption",
        at: now,
      });
      return { status: "stopped", reason: "corruption" };
    case "retry": {
      const attempts = op.attempts + 1;
      if (
        decision.error.kind === "server" &&
        attempts >= OUTBOX_MAX_SERVER_ATTEMPTS
      ) {
        await update({
          status: "conflict",
          attempts,
          lastError: {
            kind: "server",
            code: "SERVER_UNAVAILABLE",
            ...(decision.error.httpStatus
              ? { httpStatus: decision.error.httpStatus }
              : {}),
          },
        });
        return null;
      }
      const nextAttemptAt =
        now + computeRetryDelayMs(attempts, decision.retryAfterMs);
      await update({
        status: "pending",
        attempts,
        nextAttemptAt,
        lastError: decision.error,
      });
      return {
        status: "stopped",
        reason: "error",
        nextDueAt: nextAttemptAt,
      };
    }
    case "stop-auth":
      await update({ status: "pending", lastError: decision.error });
      return { status: "stopped", reason: "auth" };
    case "stop-block": {
      // La vente reste `pending` (même UUID, même payload) : un refus n'est
      // jamais un conflit métier définitif.
      await update({ status: "pending", lastError: decision.error });
      // 1-14C.2 : refus COMMERCIAL distinct des refus de permissions ou
      // d'accès administratif.
      const commercial = isCommercialRefusalCode(decision.error.code);
      await setPartitionBlocked(s.partitionKey, {
        reason: commercial ? "subscription" : "access_denied",
        tokenFingerprint: fingerprint,
        at: now,
      });
      return {
        status: "stopped",
        reason: commercial ? "subscription" : "access-denied",
      };
    }
    case "aborted":
      await update({ status: "pending" });
      return {
        status: "stopped",
        reason: getToken() !== s.token ? "token-changed" : "aborted",
      };
  }
}
