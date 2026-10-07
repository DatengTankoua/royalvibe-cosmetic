"use client";

import Link from "next/link";
import { useAuth } from "@/contexts/auth-context";

// Jamais d'appel API ici : useAuth() ne fait que lire le user/token déjà en
// mémoire (localStorage, sans les afficher) — aucune donnée organisationnelle
// n'est rendue (pas de redirection automatique, la landing reste visible).
// 1-16B : liens stylés directement (plus de <button> dans un <a>), libellés
// qui disent l'action, et lien d'inscription masqué quand le flag
// d'affichage la ferme (le backend reste l'autorité finale).
type Variant = "header" | "menu" | "final";

const base =
  "inline-flex h-11 items-center justify-center rounded-lg px-5 text-sm font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2";

// `final` est posé sur le bandeau bleu marine : contrastes inversés.
const STYLES: Record<"light" | "dark", { primary: string; secondary: string }> =
  {
    light: {
      primary: `${base} bg-(--brand-solid) text-white hover:bg-(--brand-solid)/90 focus-visible:outline-(--brand-ink)`,
      secondary: `${base} border border-(--brand-ink)/40 text-(--brand-ink) hover:border-(--brand-ink) hover:bg-(--brand-ink)/5 focus-visible:outline-(--brand-ink)`,
    },
    dark: {
      primary: `${base} bg-(--brand-orange) text-(--brand-navy) hover:bg-[#ff8533] focus-visible:outline-white`,
      secondary: `${base} border border-white/50 text-white hover:border-white hover:bg-(--public-bg)/10 focus-visible:outline-white`,
    },
  };

export function SessionCta({ variant }: { variant: Variant }) {
  const { user, isLoading } = useAuth();
  const registrationEnabled =
    process.env.NEXT_PUBLIC_REGISTRATION_ENABLED === "true";
  const styles = STYLES[variant === "final" ? "dark" : "light"];
  const layout =
    variant === "header"
      ? "flex items-center gap-2"
      : variant === "menu"
        ? "grid grid-cols-1 gap-2"
        : "flex flex-col gap-3 sm:flex-row";

  // Session non résolue : état neutre non interactif, hauteur stable (h-11)
  // — jamais traité comme "non connecté" (pas de flash Connexion/Inscription).
  if (isLoading) {
    return (
      <div aria-busy="true" className={layout}>
        <span className={`${styles.secondary} opacity-60`}>Chargement…</span>
      </div>
    );
  }

  if (user) {
    return (
      <div className={layout}>
        <Link href="/app" className={styles.primary}>
          Ouvrir l&apos;application
        </Link>
      </div>
    );
  }

  const login = (
    <Link key="login" href="/auth/login" className={styles.secondary}>
      Se connecter
    </Link>
  );
  const register = registrationEnabled && (
    <Link key="register" href="/auth/register" className={styles.primary}>
      Créer un compte
    </Link>
  );
  // Appel final : l'inscription d'abord (action principale de la section).
  return (
    <div className={layout}>
      {variant === "final" ? [register, login] : [login, register]}
    </div>
  );
}
