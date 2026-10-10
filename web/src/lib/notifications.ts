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
      // 1-19A : absents sans `sales.view_all` (droit de consulter les chiffres).
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
  | { kind: "monthly-report"; missing: true }
  | MemberJoinedDetails
  | MemberActivityDetails;

// 1-19A — Nouveau membre : nom figé, rôle ACTUEL s'il est encore actif.
export interface MemberJoinedDetails {
  kind: "member-joined";
  memberName: string | null;
  role: "owner" | "admin" | "seller" | null;
  active: boolean;
  occurredAt: string;
}

export type MemberActivityEntity =
  "product" | "section" | "sale" | "invitation" | "member" | "branding";

export type MemberActivityAction =
  | "created"
  | "updated"
  | "trashed"
  | "restored"
  | "purged"
  | "cancelled"
  | "revoked";

// 1-19A — Activité d'un membre (propriétaire seul). Noms figés ; `link`
// seulement si la cible existe encore (jamais de lien cassé).
export interface MemberActivityDetails {
  kind: "member-activity";
  actorName: string | null;
  entity: MemberActivityEntity | null;
  action: MemberActivityAction | null;
  count: number;
  occurredAt: string;
  totalTargets: number;
  targets: Array<{
    name: string | null;
    link: string | null;
    inTrash: boolean;
    removed: boolean;
  }>;
  link: string | null;
}

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

// 1-16G : libellé et aide de chaque catégorie dans `notifications`
// (`categories.<clé>.label` / `.help`).
export const CATEGORY_KEYS: Record<PushCategory, keyof PushPreferences> = {
  "stock-depleted": "stockDepleted",
  "stock-low": "stockLow",
  "sale-created": "saleCreated",
  "subscription-ending": "subscriptionEnding",
  "payment-succeeded": "paymentSucceeded",
  "monthly-report": "monthlyReport",
  "member-joined": "memberJoined",
  "member-activity": "memberActivity",
};
