import axios from "axios";
import { apiClient } from "./api";
import { parseRetryAfterMs } from "./offline-sales-policy";
import type { SubscriptionTerm } from "./subscription-offers";

// 1-14D.2C — Client des paiements d'abonnement (contrats 1-14D.2B).
//
// - Propriétaire réel uniquement ; le serveur reste l'autorité.
// - `token` : jeton LIMITÉ explicite (session `/access`) ; absent = JWT
//   applicatif courant (intercepteur Axios).
// - Appels DIRECTS : jamais l'outbox des ventes, jamais de relance
//   automatique, jamais de cache (réponses API `no-store` ; le service worker
//   n'intercepte ni l'API ni `/app`).
// - Aucun téléphone en clair n'est conservé : il ne transite que dans le
//   corps de la création.

export type SubscriptionPaymentStatus =
  "initiating" | "pending" | "uncertain" | "review" | "succeeded" | "failed";

/** Projection EXACTE de l'API (`SubscriptionPaymentView`). */
export interface ApiSubscriptionPayment {
  paymentId: string;
  reference: string;
  status: SubscriptionPaymentStatus;
  term: SubscriptionTerm;
  /** Montant TOTAL figé à la création (XAF). */
  amount: number;
  currency: "XAF";
  /** 1-21B : `null` quand aucun numéro n'a été demandé (page hébergée). */
  payerPhoneMasked: string | null;
  /**
   * 1-21B : page de paiement hébergée à rouvrir (paiement ouvert seulement ;
   * absente d'une API antérieure). Ouvrir cette page ne prouve rien.
   */
  checkoutUrl?: string | null;
  createdAt: string | null;
  initiatedAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
}

export interface ApiSubscriptionPaymentPage {
  items: ApiSubscriptionPayment[];
  nextCursor: string | null;
}

/** États qui interdisent toute nouvelle collecte (serveur : `open`). */
export const BLOCKING_PAYMENT_STATUSES: ReadonlySet<SubscriptionPaymentStatus> =
  new Set(["initiating", "pending", "uncertain", "review"]);

export const PAYMENT_HISTORY_PAGE_SIZE = 5;

const PAYMENTS_PATH = "/organizations/current/subscription/payments";

const explicitBearer = (token?: string) =>
  token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;

/** 1-21B — moyen de paiement des NOUVELLES tentatives (aucun secret). */
export interface PaymentCapabilities {
  available: boolean;
  method: "hosted-checkout" | "mobile-money" | null;
}

/**
 * 1-21B — Moyen proposé par le serveur. API antérieure (route absente) :
 * numéro Mobile Money, comme avant ; toute autre erreur est propagée.
 */
export async function fetchPaymentCapabilities(
  token?: string,
): Promise<PaymentCapabilities> {
  try {
    const { data } = await apiClient.get<PaymentCapabilities>(
      `${PAYMENTS_PATH}/capabilities`,
      explicitBearer(token),
    );
    return data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return { available: true, method: "mobile-money" };
    }
    throw error;
  }
}

/**
 * 1-21B — Page de paiement : ouverte seulement si elle est en HTTPS (le
 * serveur a déjà vérifié l'hôte du prestataire). Jamais construite ici.
 */
export function safeCheckoutUrl(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export async function createSubscriptionPayment(
  input: {
    term: SubscriptionTerm;
    /** 1-21B : absent pour une page de paiement hébergée. */
    payerPhone?: string;
    clientOperationId: string;
  },
  token?: string,
): Promise<ApiSubscriptionPayment & { replayed: boolean }> {
  const { data } = await apiClient.post<
    ApiSubscriptionPayment & { replayed: boolean }
  >(
    PAYMENTS_PATH,
    {
      term: input.term,
      ...(input.payerPhone !== undefined
        ? { payerPhone: input.payerPhone }
        : {}),
      clientOperationId: input.clientOperationId,
    },
    explicitBearer(token),
  );
  return data;
}

/** Lecture LOCALE (aucun appel au prestataire). */
export async function fetchSubscriptionPayment(
  paymentId: string,
  token?: string,
): Promise<ApiSubscriptionPayment> {
  const { data } = await apiClient.get<ApiSubscriptionPayment>(
    `${PAYMENTS_PATH}/${encodeURIComponent(paymentId)}`,
    explicitBearer(token),
  );
  return data;
}

/** Vérification EXTERNE, uniquement sur action explicite (corps vide). */
export async function refreshSubscriptionPayment(
  paymentId: string,
  token?: string,
): Promise<ApiSubscriptionPayment> {
  const { data } = await apiClient.post<ApiSubscriptionPayment>(
    `${PAYMENTS_PATH}/${encodeURIComponent(paymentId)}/refresh`,
    undefined,
    explicitBearer(token),
  );
  return data;
}

export async function listSubscriptionPayments(
  options: { limit: number; before?: string | null },
  token?: string,
): Promise<ApiSubscriptionPaymentPage> {
  const params: Record<string, string> = { limit: String(options.limit) };
  if (options.before) params.before = options.before;
  const { data } = await apiClient.get<ApiSubscriptionPaymentPage>(
    PAYMENTS_PATH,
    { ...explicitBearer(token), params },
  );
  return data;
}

// ─── Erreurs ─────────────────────────────────────────────────────────────────

export type PaymentErrorKind =
  /** Aucune réponse : la requête a PEUT-ÊTRE été traitée. */
  | { kind: "no-response" }
  | { kind: "unauthorized" }
  | { kind: "forbidden"; code: string | undefined }
  | { kind: "already-pending"; paymentId: string | null }
  | { kind: "operation-conflict" }
  | { kind: "invalid-phone" }
  | { kind: "invalid-request" }
  | { kind: "not-found" }
  | { kind: "rate-limited"; retryAfterMs: number | undefined }
  | { kind: "service-unavailable" }
  | { kind: "status-unavailable" }
  | { kind: "confirmation-pending" }
  /** Réponse serveur inattendue (5xx…) : issue inconnue. */
  | { kind: "unexpected"; status: number };

export function classifyPaymentError(
  error: unknown,
  now: number = Date.now(),
): PaymentErrorKind {
  if (!axios.isAxiosError(error) || !error.response) {
    return { kind: "no-response" };
  }
  const { status, data, headers } = error.response;
  const body = (data ?? {}) as { code?: unknown; paymentId?: unknown };
  const code = typeof body.code === "string" ? body.code : undefined;
  switch (code) {
    case "PAYMENT_ALREADY_PENDING":
      return {
        kind: "already-pending",
        paymentId:
          typeof body.paymentId === "string" && body.paymentId.length > 0
            ? body.paymentId
            : null,
      };
    case "PAYMENT_OPERATION_CONFLICT":
      return { kind: "operation-conflict" };
    case "INVALID_PAYER_PHONE":
      return { kind: "invalid-phone" };
    case "PAYMENT_NOT_FOUND":
      return { kind: "not-found" };
    case "PAYMENT_RATE_LIMITED": {
      const header = (headers as Record<string, unknown> | undefined)?.[
        "retry-after"
      ];
      return {
        kind: "rate-limited",
        retryAfterMs: parseRetryAfterMs(
          typeof header === "string" ? header : undefined,
          now,
        ),
      };
    }
    case "PAYMENT_SERVICE_UNAVAILABLE":
      return { kind: "service-unavailable" };
    case "PAYMENT_STATUS_UNAVAILABLE":
      return { kind: "status-unavailable" };
    case "PAYMENT_CONFIRMATION_PENDING":
      return { kind: "confirmation-pending" };
  }
  if (status === 401) return { kind: "unauthorized" };
  if (status === 403) return { kind: "forbidden", code };
  if (status === 400) return { kind: "invalid-request" };
  if (status === 404) return { kind: "not-found" };
  if (status === 429) {
    const header = (headers as Record<string, unknown> | undefined)?.[
      "retry-after"
    ];
    return {
      kind: "rate-limited",
      retryAfterMs: parseRetryAfterMs(
        typeof header === "string" ? header : undefined,
        now,
      ),
    };
  }
  return { kind: "unexpected", status };
}

/**
 * Création : issue DÉFINITIVE (aucun paiement créé par CETTE requête) ?
 * Sinon (aucune réponse, 5xx inattendu), le serveur a peut-être créé le
 * paiement : l'intention (UUID + durée) DOIT être rejouée telle quelle.
 */
export function isDefinitiveCreationRefusal(error: PaymentErrorKind): boolean {
  return (
    error.kind === "invalid-phone" ||
    error.kind === "invalid-request" ||
    error.kind === "already-pending" ||
    error.kind === "forbidden" ||
    error.kind === "unauthorized"
  );
}

// ─── Identifiant d'opération ─────────────────────────────────────────────────

/** UUID v4 (Web Crypto). */
export function newClientOperationId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
