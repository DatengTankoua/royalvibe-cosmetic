// 1-11C.2 — Politique PURE de l'outbox des ventes hors ligne : aucune E/S,
// aucun état global. Classification des réponses de `POST /sales`, backoff,
// Retry-After, expiration et stock indicatif.

export const OUTBOX_MAX_UNFINALIZED_PER_PARTITION = 200;
export const OUTBOX_PENDING_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const OUTBOX_SYNCED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const OUTBOX_MAX_SERVER_ATTEMPTS = 8;
export const OUTBOX_BACKOFF_MIN_MS = 2_000;
export const OUTBOX_BACKOFF_MAX_MS = 5 * 60 * 1000;

export type OutboxStatus =
  "pending" | "syncing" | "synced" | "conflict" | "abandoned";

export type OutboxErrorKind =
  "network" | "server" | "business" | "auth" | "corruption";

export interface OutboxLastError {
  kind: OutboxErrorKind;
  code?: string;
  httpStatus?: number;
}

// Statuts « non finalisés » comptés dans la limite de 200 : tout ce qui
// attend encore un envoi ou une action utilisateur.
export function isUnfinalized(status: OutboxStatus): boolean {
  return status === "pending" || status === "syncing" || status === "conflict";
}

// Issue observée d'un envoi, sans objet Axios (testable isolément).
export type SaleSyncOutcome =
  | { kind: "success"; saleId: string }
  | { kind: "network" }
  | { kind: "aborted" }
  | { kind: "http"; status: number; code?: string; retryAfterMs?: number };

export type SaleSyncDecision =
  // 201 / déjà appliquée : finalisée, on passe à la suivante.
  | { action: "synced"; code?: string }
  // Conflit terminal : action utilisateur requise, on passe à la suivante.
  | { action: "conflict"; error: OutboxLastError }
  // Clé idempotente incohérente : conflit + partition bloquée, arrêt.
  | { action: "conflict-block"; error: OutboxLastError }
  // Réessai plus tard : la tête de file attend (FIFO), arrêt de la passe.
  | {
      action: "retry";
      error: OutboxLastError;
      consumesAttempt: true;
      retryAfterMs?: number;
    }
  // Session invalide : aucune tentative consommée, arrêt immédiat.
  | { action: "stop-auth"; error: OutboxLastError }
  // Accès refusé : aucune tentative consommée, partition bloquée, arrêt.
  | { action: "stop-block"; error: OutboxLastError }
  // Passe annulée localement (token changé, stop) : rien n'est consommé.
  | { action: "aborted" };

const TERMINAL_BUSINESS_CODES = new Set([
  "INSUFFICIENT_STOCK",
  "SALE_DATE_OUT_OF_RANGE",
  "PRODUCT_NOT_FOUND",
]);

export function classifySaleSyncOutcome(
  outcome: SaleSyncOutcome,
): SaleSyncDecision {
  switch (outcome.kind) {
    case "success":
      return { action: "synced" };
    case "aborted":
      return { action: "aborted" };
    case "network":
      return {
        action: "retry",
        error: { kind: "network" },
        consumesAttempt: true,
      };
    case "http":
      return classifyHttp(outcome.status, outcome.code, outcome.retryAfterMs);
  }
}

function classifyHttp(
  status: number,
  code: string | undefined,
  retryAfterMs: number | undefined,
): SaleSyncDecision {
  if (status >= 200 && status < 300) return { action: "synced" };
  if (status === 401) {
    return { action: "stop-auth", error: { kind: "auth", httpStatus: 401 } };
  }
  if (status === 403) {
    return {
      action: "stop-block",
      error: { kind: "auth", httpStatus: 403, ...(code ? { code } : {}) },
    };
  }
  if (status === 409 && code === "SALE_OPERATION_ALREADY_APPLIED") {
    return { action: "synced", code };
  }
  if (
    status === 409 &&
    (code === "IDEMPOTENCY_KEY_REUSED" || code === "IDEMPOTENCY_KEY_CONFLICT")
  ) {
    return {
      action: "conflict-block",
      error: { kind: "corruption", httpStatus: 409, code },
    };
  }
  if (status === 429 || status >= 500) {
    return {
      action: "retry",
      error: { kind: "server", httpStatus: status },
      consumesAttempt: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }
  // 400 validation / INSUFFICIENT_STOCK / SALE_DATE_OUT_OF_RANGE,
  // 404 PRODUCT_NOT_FOUND et tout autre 4xx : conflit terminal.
  return {
    action: "conflict",
    error: {
      kind: "business",
      httpStatus: status,
      code:
        code && TERMINAL_BUSINESS_CODES.has(code)
          ? code
          : (code ?? (status === 400 ? "VALIDATION_FAILED" : `HTTP_${status}`)),
    },
  };
}

// Backoff exponentiel borné [2 s, 5 min] avec jitter ±20 % (toujours ≥ 2 s :
// jamais de boucle immédiate). `attempts` = tentatives déjà consommées (≥ 1).
export function computeBackoffMs(
  attempts: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  const base = Math.min(
    OUTBOX_BACKOFF_MAX_MS,
    OUTBOX_BACKOFF_MIN_MS * 2 ** exponent,
  );
  const jittered = base * (0.8 + 0.4 * random());
  return clampDelay(jittered);
}

// Délai effectif : le plus grand du backoff et du Retry-After, borné.
export function computeRetryDelayMs(
  attempts: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  return clampDelay(
    Math.max(computeBackoffMs(attempts, random), retryAfterMs ?? 0),
  );
}

function clampDelay(ms: number): number {
  return Math.round(
    Math.min(OUTBOX_BACKOFF_MAX_MS, Math.max(OUTBOX_BACKOFF_MIN_MS, ms)),
  );
}

// `Retry-After` : secondes entières ou date HTTP. Invalide/absent → undefined.
export function parseRetryAfterMs(
  header: string | null | undefined,
  now: number,
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

export function isPendingExpired(createdAt: number, now: number): boolean {
  return now - createdAt > OUTBOX_PENDING_MAX_AGE_MS;
}

export function isSyncedPurgeable(updatedAt: number, now: number): boolean {
  return now - updatedAt > OUTBOX_SYNCED_RETENTION_MS;
}

// Stock INDICATIF : stock serveur connu moins les ventes locales non encore
// confirmées (pending/syncing) de ce produit, jamais négatif. Le serveur
// reste l'autorité finale.
export function computeIndicativeStock(
  remainingQuantity: number,
  operations: ReadonlyArray<{
    status: OutboxStatus;
    payload: { productId: string; quantity: number };
  }>,
  productId: string,
): number {
  const reserved = operations
    .filter(
      (op) =>
        (op.status === "pending" || op.status === "syncing") &&
        op.payload.productId === productId,
    )
    .reduce((sum, op) => sum + op.payload.quantity, 0);
  return Math.max(0, remainingQuantity - reserved);
}
