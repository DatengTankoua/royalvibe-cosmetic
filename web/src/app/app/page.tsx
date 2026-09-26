"use client";

import Link from "next/link";
import { useAuth } from "@/contexts/auth-context";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { Wordmark } from "@/components/brand/wordmark";

// Accueil du shell (1-9A/1-9B, lien mis à jour en 1-9D) : les pages métier
// vivent maintenant sous /app/catalog, /app/sales, /app/analytics, /app/trash.
// Le garde d'authentification vit dans app/app/layout.tsx (shell partagé).
export default function AppHomePage() {
  const { user } = useAuth();
  const { organization } = useOrganizationShell();

  if (!user) return null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 px-4 py-12 text-center">
      <Wordmark size="large" />
      <p className="text-sm text-muted-foreground">
        Bienvenue, {user.name}
        {organization ? ` — ${organization.name}` : ""}.
      </p>
      <Link
        href="/app/catalog"
        className="inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium text-white"
        style={{ backgroundColor: "var(--brand-navy)" }}
      >
        Accéder au catalogue
      </Link>
    </div>
  );
}
