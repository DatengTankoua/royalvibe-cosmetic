"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useOrganizationShell } from "@/contexts/organization-shell-context";

const TABS = [
  { href: "/app/organization/branding", label: "Branding" },
  {
    href: "/app/organization/members",
    label: "Membres",
    permission: "members.manage" as const,
  },
  {
    href: "/app/organization/invitations",
    label: "Invitations",
    permission: "members.invite" as const,
  },
  { href: "/app/organization/offline-data", label: "Hors connexion" },
];

// Sous-shell de la section « Organisation » (1-9C) : onglets filtrés par
// permissions effectives. Le masquage n'est qu'une aide UX — chaque route
// backend reste gardée indépendamment (`branding.manage`, `members.manage`,
// `members.invite`).
export default function OrganizationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { authContext } = useOrganizationShell();
  const effective = authContext?.effectivePermissions ?? [];

  const tabs = TABS.filter(
    (tab) => !tab.permission || effective.includes(tab.permission),
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 py-6 sm:px-6">
      <h1 className="text-xl font-bold">Organisation</h1>
      <nav className="mt-4 flex gap-1 overflow-x-auto border-b">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={`shrink-0 rounded-t-md px-3 py-2 text-sm font-medium ${
              pathname.startsWith(tab.href)
                ? "border-b-2 border-primary text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <div className="mt-6 flex-1">{children}</div>
    </div>
  );
}
