"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/auth-context";

// Jamais d'appel API ici : useAuth() ne fait que lire le user/token déjà en
// mémoire (localStorage, sans les afficher) — aucune donnée organisationnelle
// n'est rendue (pas de redirection automatique, la landing reste visible).
export function SessionCta({
  variant,
}: {
  variant: "header" | "hero" | "final";
}) {
  const { user, isLoading } = useAuth();

  // Session non résolue : état neutre non interactif, hauteur stable (h-11)
  // — jamais traité comme "non connecté" (pas de flash Connexion/Inscription).
  if (isLoading) {
    return (
      <div aria-busy="true" className="flex items-center justify-center">
        <Button
          type="button"
          disabled
          variant="outline"
          className="h-11 border-(--brand-navy)/30 px-6 text-(--brand-navy)/60"
        >
          Chargement…
        </Button>
      </div>
    );
  }

  if (user) {
    return (
      <Link href="/app">
        <Button className="h-11 bg-(--brand-navy) px-6 text-white hover:bg-(--brand-navy)/90">
          Ouvrir l&apos;application
        </Button>
      </Link>
    );
  }

  const stacked = variant !== "header";
  return (
    <div
      className={
        stacked
          ? "flex flex-col items-center gap-3 sm:flex-row"
          : "flex items-center gap-2"
      }
    >
      <Link href="/auth/login">
        <Button
          variant="outline"
          className="h-11 border-(--brand-navy) px-6 text-(--brand-navy) hover:bg-(--brand-navy)/5"
        >
          Connexion
        </Button>
      </Link>
      <Link href="/auth/register">
        <Button className="h-11 bg-(--brand-navy) px-6 text-white hover:bg-(--brand-navy)/90">
          Inscription
        </Button>
      </Link>
    </div>
  );
}
