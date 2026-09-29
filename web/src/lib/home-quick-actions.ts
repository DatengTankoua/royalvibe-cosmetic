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

export interface QuickAction {
  id: QuickActionId;
  title: string;
  description: string;
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
): { href: string; description: string } | null {
  const branding = hasPermission(ctx, "branding.manage");
  const members = hasPermission(ctx, "members.manage");
  const invite = hasPermission(ctx, "members.invite");
  const parts = [
    branding && "logo et couleur",
    members && "membres",
    invite && "invitations",
  ].filter((p): p is string => Boolean(p));
  if (parts.length === 0) return null;
  const href = branding
    ? "/app/organization/branding"
    : members
      ? "/app/organization/members"
      : "/app/organization/invitations";
  const text = parts.join(", ");
  return {
    href,
    description: `${text.charAt(0).toUpperCase()}${text.slice(1)}`,
  };
}

export function homeQuickActions(ctx: AuthLike): QuickAction[] {
  const actions: QuickAction[] = [
    {
      id: "catalog",
      title: "Catalogue",
      description: "Rayons, produits et stock",
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
      title: "Ventes",
      description: viewAll
        ? "Toutes les ventes du commerce"
        : viewOwn
          ? "Vos ventes enregistrées"
          : "Saisie depuis une fiche produit",
      href: "/app/sales",
      availableOffline: false,
    });
  }
  if (hasPermission(ctx, "analytics.read")) {
    actions.push({
      id: "analytics",
      title: "Analyse",
      description: "Chiffre d'affaires et évolution",
      href: "/app/analytics",
      availableOffline: false,
    });
  }
  if (hasPermission(ctx, "trash.manage")) {
    actions.push({
      id: "trash",
      title: "Corbeille",
      description: "Restaurer ou supprimer définitivement",
      href: "/app/trash",
      availableOffline: false,
    });
  }
  const org = organizationTarget(ctx);
  if (org) {
    actions.push({
      id: "organization",
      title: "Organisation",
      description: org.description,
      href: org.href,
      availableOffline: false,
    });
  }
  actions.push({
    id: "converter",
    title: "Convertisseur",
    description: "Euro ↔ franc CFA, taux fixe",
    availableOffline: true,
  });
  return actions;
}
