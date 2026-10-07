import axios from "axios";
import type { TFunction } from "i18next";
import { currentLocale } from "@/i18n/client-t";
import { apiClient, isCommercialRefusalCode } from "@/lib/api";
import type { ApiAuthContext } from "@/lib/api";

// 1-16D — historique mensuel exportable (Excel, PDF), généré par l'API.
// Les contrôles d'accès sont faits côté serveur à chaque requête ; ce
// module ne fait que masquer l'interface quand elle serait refusée.

export type MonthlyHistoryFormat = "xlsx" | "pdf";

export interface MonthlyHistoryMonths {
  timeZone: string;
  currentMonth: string;
  filenamePrefix: string;
  months: Array<{ month: string; salesCount: number }>;
}

/** Même règle que le serveur : propriétaire ou administrateur, avec les droits. */
export function canDownloadMonthlyHistory(
  context: ApiAuthContext | null,
): boolean {
  if (!context) return false;
  if (context.role !== "owner" && context.role !== "admin") return false;
  const effective = new Set(context.effectivePermissions ?? []);
  return effective.has("analytics.read") && effective.has("sales.view_all");
}

export async function fetchMonthlyHistoryMonths(): Promise<MonthlyHistoryMonths> {
  const { data } =
    await apiClient.get<MonthlyHistoryMonths>("/reports/monthly");
  return data;
}

/** Télécharge le fichier et le propose à l'enregistrement. */
export async function downloadMonthlyHistory(
  month: string,
  format: MonthlyHistoryFormat,
  filenamePrefix: string,
): Promise<void> {
  // 1-16G : libellés du fichier dans la langue de l'interface (mêmes
  // ventes, mêmes chiffres, mêmes noms ; devise et fuseau inchangés).
  const { data } = await apiClient.get<Blob>(
    `/reports/monthly/${month}/${format}`,
    { responseType: "blob", params: { lang: currentLocale() } },
  );
  const url = URL.createObjectURL(data);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filenamePrefix}-${month}.${format}`;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Délai : certains navigateurs mobiles lisent l'URL après le clic.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

type AnalyticsT = TFunction<"analytics">;
/** Clé traduite au rendu, ou message déjà traduit par l'API. */
export type MonthlyHistoryMessage = string | ((t: AnalyticsT) => string);

/**
 * Message compréhensible pour un échec (le corps d'erreur est un Blob).
 * 1-16G : traduit dans la langue courante ; un message propre au serveur
 * (caractères PDF, limitation) arrive déjà dans la langue de la requête.
 */
export async function describeMonthlyHistoryError(
  error: unknown,
): Promise<MonthlyHistoryMessage> {
  if (!axios.isAxiosError(error)) {
    return (t) => t("monthly.errors.generic");
  }
  if (!error.response) {
    return (t) => t("monthly.errors.network");
  }
  let code: unknown;
  let serverMessage: unknown;
  const body = error.response.data as unknown;
  try {
    const parsed = body instanceof Blob ? JSON.parse(await body.text()) : body;
    code = (parsed as { code?: unknown } | null)?.code;
    serverMessage = (parsed as { message?: unknown } | null)?.message;
  } catch {
    code = undefined;
  }
  const status = error.response.status;
  if (isCommercialRefusalCode(code)) {
    return (t) => t("monthly.errors.subscription");
  }
  if (status === 403) {
    return (t) => t("monthly.errors.forbidden");
  }
  if (code === "REPORT_MONTH_INVALID") {
    return (t) => t("monthly.errors.monthInvalid");
  }
  // 1-16D : PDF refusé plutôt qu'altéré ; le message du serveur cite les
  // caractères concernés et propose l'Excel, qui les conserve exactement.
  if (code === "REPORT_PDF_UNSUPPORTED_CHARACTERS") {
    return typeof serverMessage === "string"
      ? serverMessage
      : (t) => t("monthly.errors.pdfCharacters");
  }
  if (code === "REPORT_RATE_LIMITED") {
    return typeof serverMessage === "string"
      ? serverMessage
      : (t) => t("monthly.errors.rateLimited");
  }
  if (code === "REPORT_GENERATION_BUSY") {
    return (t) => t("monthly.errors.busy");
  }
  if (code === "REPORT_DATA_CHANGED") {
    return (t) => t("monthly.errors.dataChanged");
  }
  if (status >= 500) {
    return (t) => t("monthly.errors.server");
  }
  return (t) => t("monthly.errors.generic");
}
