import axios from "axios";
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
  const { data } = await apiClient.get<Blob>(
    `/reports/monthly/${month}/${format}`,
    { responseType: "blob" },
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

/** Message compréhensible pour un échec (le corps d'erreur est un Blob). */
export async function describeMonthlyHistoryError(
  error: unknown,
): Promise<string> {
  if (!axios.isAxiosError(error)) {
    return "Le fichier n'a pas pu être préparé. Réessayez.";
  }
  if (!error.response) {
    return "Impossible de joindre le serveur. Vérifiez votre connexion puis réessayez.";
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
    return "L'abonnement de ce commerce n'est pas actif : le téléchargement est indisponible.";
  }
  if (status === 403) {
    return "Votre rôle ou vos droits actuels ne permettent pas de télécharger cet historique.";
  }
  if (code === "REPORT_MONTH_INVALID") return "Ce mois n'est pas disponible.";
  // 1-16D : PDF refusé plutôt qu'altéré ; le message du serveur cite les
  // caractères concernés et propose l'Excel, qui les conserve exactement.
  if (code === "REPORT_PDF_UNSUPPORTED_CHARACTERS") {
    return typeof serverMessage === "string"
      ? serverMessage
      : "Certains noms ne peuvent pas être reproduits fidèlement en PDF. Téléchargez la version Excel.";
  }
  if (code === "REPORT_RATE_LIMITED") {
    return typeof serverMessage === "string"
      ? serverMessage
      : "Trop de téléchargements d'historique en peu de temps. Réessayez plus tard.";
  }
  if (code === "REPORT_GENERATION_BUSY") {
    return "D'autres rapports sont en cours de préparation. Réessayez dans quelques secondes.";
  }
  if (code === "REPORT_DATA_CHANGED") {
    return "Des ventes ont changé pendant la préparation. Réessayez dans un instant.";
  }
  if (status >= 500) {
    return "Le serveur n'a pas pu préparer le fichier. Réessayez dans quelques instants.";
  }
  return "Le fichier n'a pas pu être préparé. Réessayez.";
}
