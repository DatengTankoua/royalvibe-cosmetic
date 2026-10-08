// 1-12B — Accès rapides de l'accueil /app : mapping PUR carte → route →
// permission → comportement hors ligne (testable sans DOM). Décisions
// exclusivement sur `authContext.effectivePermissions` (GET /auth/context,
// helper `hasPermission`), jamais `User.role`/`ApiUser.role`. Masquage UX
// uniquement : chaque route backend reste gardée indépendamment.
import {
  hasPermission,
  type DelegablePermission,
} from "./organization-permissions";

export type QuickActionId =
  "catalog" | "sales" | "analytics" | "trash" | "organization" | "converter";

// 1-16G : titres et descriptions dans `catalog` (`home.actions.*`) ; ce
// module ne porte que des identifiants (mapping pur, testable sans DOM).
export type QuickActionDescription =
  | "catalog"
  | "salesAll"
  | "salesOwn"
  | "salesRecord"
  | "analytics"
  | "trash"
  | "organization"
  | "converter";

export type OrganizationPart = "branding" | "members" | "invitations";

export interface QuickAction {
  id: QuickActionId;
  description: QuickActionDescription;
  /** Organisation : capacités administrables, dans l'ordre d'affichage. */
  parts?: OrganizationPart[];
  /** Route interne ; absente pour le convertisseur (dialogue existant). */
  href?: string;
  /**
   * Vrai si l'action fonctionne sur une page déjà montée sans réseau :
   * `/app/catalog` (document servi par le service worker) et le
   * convertisseur (taux fixe, aucun appel réseau).
   */
  availableOffline: boolean;
}

type AuthLike = { effectivePermissions: DelegablePermission[] } | null;

/**
 * Onglet Organisation le plus pertinent parmi les capacités réellement
 * administrables (jamais un écran systématiquement refusé) ; `null` si
 * aucune : la carte n'est pas rendue.
 */
function organizationTarget(
  ctx: AuthLike,
): { href: string; parts: OrganizationPart[] } | null {
  const branding = hasPermission(ctx, "branding.manage");
  const members = hasPermission(ctx, "members.manage");
  const invite = hasPermission(ctx, "members.invite");
  const parts: OrganizationPart[] = [];
  if (branding) parts.push("branding");
  if (members) parts.push("members");
  if (invite) parts.push("invitations");
  if (parts.length === 0) return null;
  const href = branding
    ? "/app/organization/branding"
    : members
      ? "/app/organization/members"
      : "/app/organization/invitations";
  return { href, parts };
}

export function homeQuickActions(ctx: AuthLike): QuickAction[] {
  const actions: QuickAction[] = [
    {
      id: "catalog",
      description: "catalog",
      href: "/app/catalog",
      availableOffline: true,
    },
  ];

  // Mêmes droits que la page Ventes (1-9D) : consultation OU saisie.
  const viewAll = hasPermission(ctx, "sales.view_all");
  const viewOwn = hasPermission(ctx, "sales.view_own");
  if (viewAll || viewOwn || hasPermission(ctx, "sales.record")) {
    actions.push({
      id: "sales",
      description: viewAll ? "salesAll" : viewOwn ? "salesOwn" : "salesRecord",
      href: "/app/sales",
      availableOffline: false,
    });
  }
  if (hasPermission(ctx, "analytics.read")) {
    actions.push({
      id: "analytics",
      description: "analytics",
      href: "/app/analytics",
      availableOffline: false,
    });
  }
  if (hasPermission(ctx, "trash.manage")) {
    actions.push({
      id: "trash",
      description: "trash",
      href: "/app/trash",
      availableOffline: false,
    });
  }
  const org = organizationTarget(ctx);
  if (org) {
    actions.push({
      id: "organization",
      description: "organization",
      parts: org.parts,
      href: org.href,
      availableOffline: false,
    });
  }
  actions.push({
    id: "converter",
    description: "converter",
    availableOffline: true,
  });
  return actions;
}
