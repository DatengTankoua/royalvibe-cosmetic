"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "next-i18next/client";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { STORAGE_USAGE_PERMISSIONS } from "@/lib/organization-permissions";

// 1-16G : libellés dans `organization` (`tabs.*`).
const TABS = [
  { href: "/app/organization/branding", key: "branding" as const },
  {
    href: "/app/organization/members",
    key: "members" as const,
    permission: "members.manage" as const,
  },
  {
    href: "/app/organization/invitations",
    key: "invitations" as const,
    permission: "members.invite" as const,
  },
  // 1-14C.2 : propriétaire RÉEL uniquement (rôle de la membership renvoyé
  // par le serveur) — jamais `User.role` ni une permission déléguée.
  {
    href: "/app/organization/subscription",
    key: "subscription" as const,
    ownerOnly: true,
  },
  // 1-17B : occupation du stockage — l'un des droits qui créent ou
  // libèrent des fichiers suffit (l'API revérifie).
  {
    href: "/app/organization/storage",
    key: "storage" as const,
    anyPermission: STORAGE_USAGE_PERMISSIONS,
  },
  { href: "/app/organization/offline-data", key: "offline" as const },
  // 1-16A : réglages de CET appareil, tout membre actif (les catégories
  // proposées sont décidées par le serveur selon le rôle et les droits).
  { href: "/app/organization/notifications", key: "notifications" as const },
  // 1-16C.1 : écrire au service client (permission `support.contact`,
  // propriétaire et administrateur par défaut, vendeur sur ajout explicite).
  {
    href: "/app/organization/support",
    key: "support" as const,
    permission: "support.contact" as const,
  },
];

// Sous-shell de la section « Organisation » (1-9C) : onglets filtrés par
// permissions effectives. Le masquage n'est qu'une aide UX — chaque route
// backend reste gardée indépendamment (`branding.manage`, `members.manage`,
// `members.invite`, `support.contact`).
export default function OrganizationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useT("organization");
  const pathname = usePathname();
  const { authContext } = useOrganizationShell();
  const effective = authContext?.effectivePermissions ?? [];

  const isOwner = authContext?.role === "owner";
  const tabs = TABS.filter(
    (tab) =>
      (!("permission" in tab) ||
        !tab.permission ||
        effective.includes(tab.permission)) &&
      (!("anyPermission" in tab) ||
        (tab.anyPermission?.some((p) => effective.includes(p)) ?? false)) &&
      (!("ownerOnly" in tab) || isOwner),
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 py-6 sm:px-6">
      <h1 className="text-xl font-bold">{t("title")}</h1>
      <nav className="mt-4 flex gap-1 overflow-x-auto border-b">
        {tabs.map((tab) => (
          <Link
            prefetch={false}
            key={tab.href}
            href={tab.href}
            className={`shrink-0 rounded-t-md px-3 py-2 text-sm font-medium ${
              pathname.startsWith(tab.href)
                ? "border-b-2 border-(--tenant-accent) text-(--tenant-accent-ink)"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t(`tabs.${tab.key}`)}
          </Link>
        ))}
      </nav>
      <div className="mt-6 flex-1">{children}</div>
    </div>
  );
}
