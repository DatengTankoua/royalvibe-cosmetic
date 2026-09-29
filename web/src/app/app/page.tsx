"use client";

import Link from "next/link";
import { useAuth } from "@/contexts/auth-context";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { TenantLogo } from "@/components/brand/tenant-logo";
import { firstNameOf, fullNameOf } from "@/lib/display-names";

// Accueil du shell (1-9A/1-9B, lien mis à jour en 1-9D) : les pages métier
// vivent maintenant sous /app/catalog, /app/sales, /app/analytics, /app/trash.
// Le garde d'authentification vit dans app/app/layout.tsx (shell partagé).
// 1-12A : le commerce est l'identité principale (logo/initiales, nom,
// couleur via les jetons --tenant-* du shell) ; plus de grand logo Stock
// Master dans l'espace connecté.
export default function AppHomePage() {
  const { user } = useAuth();
  const { organization } = useOrganizationShell();

  if (!user) return null;

  const organizationName = organization?.name ?? null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 px-4 py-12 text-center">
      <div className="flex w-full min-w-0 flex-col items-center gap-4 rounded-xl border border-(--tenant-accent-border) bg-(--tenant-accent-soft) px-4 py-8">
        <TenantLogo
          size="lg"
          name={organizationName}
          logoUrl={organization?.logoUrl}
        />
        {organizationName && (
          <h1
            className="w-full truncate text-xl font-semibold"
            title={fullNameOf(organizationName) ?? undefined}
          >
            {organizationName}
          </h1>
        )}
        <p
          className="w-full truncate text-sm text-foreground"
          title={fullNameOf(user.name) ?? undefined}
        >
          Bienvenue, {firstNameOf(user.name)}.
        </p>
      </div>
      <Link
        prefetch={false}
        href="/app/catalog"
        className="inline-flex items-center justify-center rounded-md bg-(--tenant-accent) px-4 py-2 text-sm font-medium text-(--tenant-accent-foreground) hover:opacity-90"
      >
        Accéder au catalogue
      </Link>
    </div>
  );
}
