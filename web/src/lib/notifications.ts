// Centre de notifications (1-16A.1) — côté navigateur.
//
// Indépendant du push : les notifications existent même sans appareil
// abonné. Liste et compteur ne marquent RIEN comme lu ; seules l'ouverture
// d'une notification et « Tout marquer comme lu » le font (serveur).
// Utilisateur, organisation et droits : décidés par le serveur à chaque
// lecture.
import { apiClient } from "./api";
import type { PushCategory, PushPreferences } from "./push-notifications";

export interface AppNotification {
  id: string;
  category: PushCategory;
  title: string;
  body: string;
  link: string;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationPage {
  items: AppNotification[];
  nextCursor: string | null;
}

export interface MonthlyReportDetails {
  kind: "monthly-report";
  missing: boolean;
  period: string;
  periodStart: string;
  periodEnd: string;
  timeZone: string;
  computedAt: string;
  salesCount: number;
  topProducts: Array<{
    productId: string;
    name: string | null;
    deleted: boolean;
    units: number;
  }>;
  sellersOfMonth: Array<{
    sellerId: string;
    name: string;
    revenue: number;
    units: number;
  }>;
  unsold: UnsoldPage;
}

export interface UnsoldPage {
  total: number;
  offset: number;
  items: Array<{
    productId: string;
    name: string;
    introducedDuringMonth: boolean;
    inTrash: boolean;
  }>;
}

export type NotificationDetails =
  | {
      kind: "stock";
      productId: string | null;
      productName?: string;
      remainingQuantity?: number;
      initialQuantity?: number;
      inTrash?: boolean;
      removed?: boolean;
    }
  | {
      kind: "sale";
      cancelled: boolean;
      productName?: string | null;
      quantity?: number;
      salePrice?: number;
      total?: number;
      sellerName?: string | null;
      occurredAt?: string;
    }
  | {
      kind: "subscription-ending";
      coverageEndsAt: string | null;
      trial: boolean;
    }
  | { kind: "payment"; term: string | null; confirmedAt: string | null }
  | MonthlyReportDetails
  | { kind: "monthly-report"; missing: true };

export interface CenterPreferences {
  categories: PushPreferences;
  available: PushCategory[];
}

/** Signal privé du serveur (payload `{}`), relu par l'API. */
export const NOTIFICATIONS_CHANGED = "notifications:changed";

export async function fetchUnreadCount(): Promise<number> {
  const { data } = await apiClient.get<{ count: number }>(
    "/notifications/unread-count",
  );
  return data.count;
}

export async function fetchNotifications(params: {
  status?: "all" | "unread";
  limit?: number;
  before?: string;
}): Promise<NotificationPage> {
  const { data } = await apiClient.get<NotificationPage>("/notifications", {
    params,
  });
  return data;
}

/** Consultation explicite : marque lue (première fois) et renvoie le détail. */
export async function openNotification(
  id: string,
): Promise<{ notification: AppNotification; details: NotificationDetails }> {
  const { data } = await apiClient.post(
    `/notifications/${encodeURIComponent(id)}/open`,
  );
  return data;
}

export async function markAllNotificationsRead(): Promise<number> {
  const { data } = await apiClient.post<{ marked: number }>(
    "/notifications/read-all",
  );
  return data.marked;
}

export async function fetchReportUnsold(
  id: string,
  offset: number,
  limit = 20,
): Promise<UnsoldPage> {
  const { data } = await apiClient.get<UnsoldPage>(
    `/notifications/${encodeURIComponent(id)}/report/unsold`,
    { params: { offset, limit } },
  );
  return data;
}

export async function fetchCenterPreferences(): Promise<CenterPreferences> {
  const { data } = await apiClient.get<CenterPreferences>(
    "/notifications/preferences",
  );
  return data;
}

export async function updateCenterPreferences(
  update: Partial<PushPreferences>,
): Promise<CenterPreferences> {
  const { data } = await apiClient.put<CenterPreferences>(
    "/notifications/preferences",
    update,
  );
  return data;
}

/** Libellé d'affichage du compteur (`99+` au-delà de 99). */
export function badgeLabel(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export const CATEGORY_LABELS: Record<
  PushCategory,
  { key: keyof PushPreferences; label: string; help: string }
> = {
  "stock-depleted": {
    key: "stockDepleted",
    label: "Stock épuisé",
    help: "Quand le stock d'un produit passe à zéro.",
  },
  "stock-low": {
    key: "stockLow",
    label: "Stock presque épuisé",
    help: "Quand 80 % du stock initial d'un produit est consommé.",
  },
  "sale-created": {
    key: "saleCreated",
    label: "Nouvelle vente",
    help: "À chaque vente enregistrée (push regroupés par minute).",
  },
  "subscription-ending": {
    key: "subscriptionEnding",
    label: "Fin d'essai ou d'abonnement",
    help: "Un rappel dans les 24 heures précédant l'échéance.",
  },
  "payment-succeeded": {
    key: "paymentSucceeded",
    label: "Paiement confirmé",
    help: "Quand un paiement d'abonnement est confirmé.",
  },
  "monthly-report": {
    key: "monthlyReport",
    label: "Bilan mensuel",
    help: "Au début de chaque mois, le bilan du mois écoulé.",
  },
};
