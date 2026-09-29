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

// Opération minimale pour le calcul de réservation (pure).
export interface StockReservationInput {
  status: OutboxStatus;
  attempts: number;
  lastError?: OutboxLastError;
  updatedAt: number;
  payload: { productId: string; quantity: number };
}

/**
 * 1-11C.3 — Une opération réserve-t-elle ENCORE du stock local ? Prudence :
 * tout ce qui a pu (ou pourra) décrémenter le stock serveur sans être déjà
 * reflété dans les données serveur affichées.
 * - pending / syncing : oui ;
 * - conflict : oui si l'issue serveur est incertaine (SERVER_UNAVAILABLE,
 *   EXPIRED déjà tentée, corruption…), non sur refus métier certain ou
 *   EXPIRED jamais envoyée ;
 * - synced : oui tant que les données serveur affichées ont été CHARGÉES
 *   (début de requête) avant la confirmation — sinon elles incluent déjà la
 *   vente. `serverLoadedAt` inconnu → réservée (jamais de stock réaugmenté
 *   artificiellement). Déjà appliquée puis annulée : non ;
 * - abandoned : non.
 */
export function reservesStock(
  op: StockReservationInput,
  serverLoadedAt?: number,
): boolean {
  switch (op.status) {
    case "pending":
    case "syncing":
      return true;
    case "conflict":
      return allowedOperationActions(op).mayBeRecorded;
    case "synced":
      if (op.lastError?.code === "SALE_OPERATION_ALREADY_APPLIED") return false;
      return serverLoadedAt === undefined || serverLoadedAt < op.updatedAt;
    default:
      return false;
  }
}

// Stock INDICATIF : stock serveur connu moins les ventes locales qui
// réservent encore du stock (`reservesStock`), jamais négatif. Le serveur
// reste l'autorité finale.
export function computeIndicativeStock(
  remainingQuantity: number,
  operations: ReadonlyArray<StockReservationInput>,
  productId: string,
  serverLoadedAt?: number,
): { value: number; reserved: number } {
  const reserved = operations
    .filter(
      (op) =>
        op.payload.productId === productId && reservesStock(op, serverLoadedAt),
    )
    .reduce((sum, op) => sum + op.payload.quantity, 0);
  return { value: Math.max(0, remainingQuantity - reserved), reserved };
}

// ─── Actions utilisateur autorisées (1-11C.3) ────────────────────────────────

export interface AllowedOperationActions {
  // pending : échéance immédiate (même UUID).
  syncNow: boolean;
  // Corriger → NOUVELLE opération (nouvel UUID) remplaçant celle-ci.
  edit: boolean;
  // Renvoi manuel avec le MÊME UUID (SERVER_UNAVAILABLE).
  retry: boolean;
  // Abandon explicite (confirmation).
  abandon: boolean;
  // Conflit d'idempotence : export + retrait explicite, jamais de renvoi.
  removeCorrupted: boolean;
  // La vente a PU être enregistrée par le serveur (réponse perdue puis
  // échec) : l'abandon doit être signalé comme risqué.
  mayBeRecorded: boolean;
}

const DEFINITIVE_BUSINESS_REFUSALS = new Set([
  "INSUFFICIENT_STOCK",
  "SALE_DATE_OUT_OF_RANGE",
  "PRODUCT_NOT_FOUND",
  "VALIDATION_FAILED",
]);

/**
 * Règles de résolution. Une correction (nouvel UUID) n'est permise que si la
 * clé actuelle n'a CERTAINEMENT pas créé de vente :
 * - refus métier du serveur pour CETTE clé (une clé déjà appliquée aurait été
 *   rejouée en 201, jamais refusée en 4xx) ;
 * - `EXPIRED` jamais envoyée (`attempts === 0`).
 * Sinon (SERVER_UNAVAILABLE, EXPIRED déjà tentée) : seul le renvoi avec le
 * même UUID ou l'abandon averti sont proposés — jamais de doublon possible.
 */
export function allowedOperationActions(op: {
  status: OutboxStatus;
  attempts: number;
  lastError?: OutboxLastError;
}): AllowedOperationActions {
  const none: AllowedOperationActions = {
    syncNow: false,
    edit: false,
    retry: false,
    abandon: false,
    removeCorrupted: false,
    mayBeRecorded: false,
  };
  if (op.status === "pending") return { ...none, syncNow: true };
  if (op.status !== "conflict") return none;
  const error = op.lastError;
  if (error?.kind === "corruption") {
    return { ...none, removeCorrupted: true, mayBeRecorded: true };
  }
  if (error?.code === "SERVER_UNAVAILABLE") {
    return { ...none, retry: true, abandon: true, mayBeRecorded: true };
  }
  if (error?.code === "EXPIRED") {
    return op.attempts === 0
      ? { ...none, edit: true, abandon: true }
      : { ...none, abandon: true, mayBeRecorded: true };
  }
  if (
    error?.kind === "business" &&
    (DEFINITIVE_BUSINESS_REFUSALS.has(error.code ?? "") ||
      (error.httpStatus !== undefined &&
        error.httpStatus >= 400 &&
        error.httpStatus < 500))
  ) {
    return { ...none, edit: true, abandon: true };
  }
  return { ...none, abandon: true, mayBeRecorded: op.attempts > 0 };
}

// Message GÉNÉRIQUE (jamais de texte serveur brut) pour une opération.
export function describeOperationError(error?: OutboxLastError): string | null {
  if (!error) return null;
  switch (error.code) {
    case "INSUFFICIENT_STOCK":
      return "Stock insuffisant côté serveur.";
    case "PRODUCT_NOT_FOUND":
      return "Produit introuvable ou supprimé.";
    case "SALE_DATE_OUT_OF_RANGE":
      return "Date de vente hors de la période autorisée.";
    case "VALIDATION_FAILED":
      return "Données de vente refusées par le serveur.";
    case "EXPIRED":
      return "Vente en attente depuis plus de 14 jours : non envoyée automatiquement.";
    case "SERVER_UNAVAILABLE":
      return "Serveur indisponible après plusieurs tentatives.";
    case "SALE_OPERATION_ALREADY_APPLIED":
      return "Déjà enregistrée par le serveur, puis annulée.";
    case "IDEMPOTENCY_KEY_REUSED":
    case "IDEMPOTENCY_KEY_CONFLICT":
    case "PARTITION_MISMATCH":
      return "Incohérence détectée : exportez cette vente et contactez le support.";
    case "ORGANIZATION_ACCESS_DENIED":
    case "PERMISSION_DENIED":
      return "Accès refusé par le serveur.";
  }
  switch (error.kind) {
    case "network":
      return "Réseau indisponible, nouvel essai automatique.";
    case "server":
      return "Envoi momentanément impossible, nouvel essai automatique.";
    case "auth":
      return "Session expirée ou accès refusé.";
    case "corruption":
      return "Incohérence détectée : exportez cette vente et contactez le support.";
    default:
      return "Vente refusée par le serveur.";
  }
}
