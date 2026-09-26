import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowLeftRightIcon,
  BarChart3Icon,
  Building2Icon,
  CheckCircle2Icon,
  LayoutGridIcon,
  ShieldCheckIcon,
  ShoppingBagIcon,
  Trash2Icon,
  TrendingUpIcon,
  UsersIcon,
  ZapIcon,
} from "lucide-react";
import { Wordmark } from "@/components/brand/wordmark";
import { SessionCta } from "@/components/landing/session-cta";

export const metadata: Metadata = {
  title: "Stock Master — Gestion des stocks et des ventes pour PME",
  description:
    "Stock Master centralise catalogue, stock, ventes, analytics et permissions multi-organisation pour les petites et moyennes entreprises.",
  openGraph: {
    title: "Stock Master — Gestion des stocks et des ventes pour PME",
    description:
      "Catalogue, stock, ventes, analytics et multi-organisation, dans une seule application.",
  },
};

const benefits = [
  {
    icon: CheckCircle2Icon,
    label: "Simple",
    description: "Une interface claire pour gérer ton catalogue au quotidien.",
  },
  {
    icon: ZapIcon,
    label: "Rapide",
    description: "Enregistre une vente et suis ton stock en quelques clics.",
  },
  {
    icon: TrendingUpIcon,
    label: "Efficace",
    description:
      "Des indicateurs clairs pour suivre la performance de l'activité.",
  },
  {
    icon: ShieldCheckIcon,
    label: "Sécurisé",
    description: "Accès et permissions gérés par organisation et par membre.",
  },
];

// Uniquement des fonctionnalités réellement livrées (voir 1-9D) — aucune
// promesse de paiement, d'app mobile native, de mode hors ligne ou d'emails
// automatiques.
const features = [
  {
    icon: LayoutGridIcon,
    label: "Catalogue & stock",
    description: "Organise sections et produits, avec suivi du stock.",
  },
  {
    icon: ShoppingBagIcon,
    label: "Ventes",
    description:
      "Enregistre chaque vente et retrouve l'historique par produit.",
  },
  {
    icon: BarChart3Icon,
    label: "Analytics",
    description: "Suis les indicateurs clés et les tendances de l'activité.",
  },
  {
    icon: Trash2Icon,
    label: "Corbeille",
    description: "Restaure ou supprime définitivement sections et produits.",
  },
  {
    icon: ArrowLeftRightIcon,
    label: "Convertisseur EUR–FCFA",
    description: "Convertis rapidement entre euros et francs CFA.",
  },
  {
    icon: Building2Icon,
    label: "Multi-organisation",
    description: "Gère plusieurs organisations et bascule entre elles.",
  },
  {
    icon: UsersIcon,
    label: "Membres et permissions",
    description: "Invite des membres et définis précisément leurs accès.",
  },
];

const steps = [
  {
    title: "Créer l'entreprise",
    description: "Inscris-toi et configure ton organisation.",
  },
  {
    title: "Ajouter les produits",
    description: "Organise ton catalogue par sections et produits.",
  },
  {
    title: "Suivre ventes et performances",
    description: "Enregistre les ventes et suis les analyses.",
  },
];

// Landing publique (1-10A) : ne déclenche aucun appel métier authentifié —
// seul `SessionCta` lit la session déjà en mémoire (jamais de fetch).
export default function LandingPage() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Wordmark className="text-lg font-bold" />
          <div className="flex flex-wrap items-center gap-4">
            <a
              href="#fonctionnalites"
              className="text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Fonctionnalités
            </a>
            <SessionCta variant="header" />
          </div>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-6xl px-4 py-16 text-center motion-safe:animate-in motion-safe:fade-in motion-safe:duration-700 sm:py-20">
          <h1 className="text-3xl font-bold tracking-tight text-(--brand-navy) sm:text-4xl md:text-5xl">
            La gestion des stocks et des ventes,{" "}
            <span className="bg-(--brand-orange)/15 px-1">simplifiée</span> pour
            les PME
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-base text-muted-foreground sm:text-lg">
            Stock Master centralise le catalogue, le stock, les ventes et le
            suivi de performance de ton entreprise, avec une gestion fine des
            accès par organisation.
          </p>
          <div className="mt-8 flex justify-center">
            <SessionCta variant="hero" />
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-12">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 sm:gap-6">
            {benefits.map(({ icon: Icon, label, description }) => (
              <div
                key={label}
                className="rounded-xl border border-border p-4 text-center sm:p-6"
              >
                <Icon
                  className="mx-auto size-8"
                  style={{ color: "var(--brand-navy)" }}
                  aria-hidden
                />
                <p className="mt-3 font-semibold">{label}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {description}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section
          id="fonctionnalites"
          className="mx-auto max-w-6xl scroll-mt-16 px-4 py-12"
        >
          <h2 className="text-center text-2xl font-bold sm:text-3xl">
            Fonctionnalités
          </h2>
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map(({ icon: Icon, label, description }) => (
              <div
                key={label}
                className="flex items-start gap-3 rounded-xl border border-border p-4"
              >
                <Icon
                  className="mt-0.5 size-6 shrink-0"
                  style={{ color: "var(--brand-navy)" }}
                  aria-hidden
                />
                <div>
                  <p className="font-semibold">{label}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-12">
          <h2 className="text-center text-2xl font-bold sm:text-3xl">
            En 3 étapes
          </h2>
          <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-3">
            {steps.map(({ title, description }, index) => (
              <div key={title} className="text-center">
                <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-(--brand-navy) font-bold text-white ring-2 ring-(--brand-orange) ring-offset-2">
                  {index + 1}
                </div>
                <p className="mt-3 font-semibold">{title}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {description}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-t border-border bg-muted/30">
          <div className="mx-auto max-w-6xl px-4 py-16 text-center">
            <h2 className="text-2xl font-bold sm:text-3xl">
              Prêt à organiser ton activité ?
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
              Crée ton organisation ou connecte-toi pour retrouver ton
              catalogue, tes ventes et tes analyses.
            </p>
            <div className="mt-8 flex justify-center">
              <SessionCta variant="final" />
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-4 py-8 text-center text-sm text-muted-foreground">
          <Wordmark className="mx-auto text-base font-semibold" />
          <p className="mt-2">
            <Link href="/auth/login" className="hover:text-foreground">
              Connexion
            </Link>
            {" · "}
            <Link href="/auth/register" className="hover:text-foreground">
              Inscription
            </Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
