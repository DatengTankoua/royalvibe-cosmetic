import { apiClient, getApiErrorCode, isNetworkError } from "./api";

// 1-16C.1 — Assistance depuis l'organisation. Miroir des bornes serveur
// (api/src/support/support-constants.ts) : aide à la saisie uniquement, le
// serveur reste l'autorité (identité, organisation et destinataire ne sont
// jamais envoyés par le navigateur).

// 1-16G : libellés dans `organization` (`support.categories.*`).
export const SUPPORT_CATEGORIES = [
  "usage",
  "subscription",
  "technical",
  "other",
] as const;

export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const SUPPORT_SUBJECT_MAX_LENGTH = 150;
export const SUPPORT_MESSAGE_MAX_LENGTH = 5000;

/** Chemin interne transmis : `/app…`, ni requête ni fragment. */
const PAGE_PATTERN = /^\/app[A-Za-z0-9/_.\-[\]]*$/;
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,40}$/;

export function safeSupportPage(value: string | null): string | undefined {
  if (!value || value.length > 200 || !PAGE_PATTERN.test(value))
    return undefined;
  return value;
}

/** Version publique facultative (`NEXT_PUBLIC_APP_VERSION`), sinon rien. */
export function publicAppVersion(): string | undefined {
  const v = process.env.NEXT_PUBLIC_APP_VERSION;
  return v && VERSION_PATTERN.test(v) ? v : undefined;
}

export interface SupportContext {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string; slug: string | null };
  membership: { id: string; role: string; permissions: string[] };
}

export interface SupportSubmitResult {
  reference: string;
  status: "sent";
  createdAt: string;
  replayed: boolean;
}

export async function fetchSupportContext(): Promise<SupportContext> {
  const { data } = await apiClient.get<SupportContext>("/support/context");
  return data;
}

export async function submitSupportRequest(payload: {
  requestId: string;
  category: SupportCategory;
  subject: string;
  message: string;
  page?: string;
  appVersion?: string;
}): Promise<SupportSubmitResult> {
  const { data } = await apiClient.post<SupportSubmitResult>(
    "/support/requests",
    payload,
  );
  return data;
}

export type SupportErrorKind =
  | "offline"
  | "uncertain"
  | "expired"
  | "in-progress"
  | "unavailable"
  | "rate-limited"
  | "forbidden"
  | "invalid"
  | "conflict";

/** Référence éventuellement renvoyée avec l'erreur (envoi incertain). */
export function supportErrorReference(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { reference?: unknown } } })
    ?.response?.data;
  return typeof data?.reference === "string" ? data.reference : undefined;
}

export function classifySupportError(error: unknown): SupportErrorKind {
  if (isNetworkError(error)) return "offline";
  const code = getApiErrorCode(error);
  const status = (error as { response?: { status?: number } })?.response
    ?.status;
  switch (code) {
    case "SUPPORT_DELIVERY_UNCERTAIN":
      return "uncertain";
    case "SUPPORT_RETRY_WINDOW_EXPIRED":
      return "expired";
    case "SUPPORT_REQUEST_IN_PROGRESS":
      return "in-progress";
    case "SUPPORT_RATE_LIMITED":
      return "rate-limited";
    case "SUPPORT_REQUEST_MISMATCH":
    case "SUPPORT_REQUEST_CONFLICT":
      return "conflict";
    case "SUPPORT_REQUEST_INVALID":
      return "invalid";
  }
  if (status === 403) return "forbidden";
  if (status === 400) return "invalid";
  return "unavailable";
}

// 1-16G : messages dans `organization` (`support.errors.<kind>`).
