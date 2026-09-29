"use client";

import Link from "next/link";
import {
  ArrowLeftRightIcon,
  BarChart3Icon,
  Building2Icon,
  LayoutGridIcon,
  ShoppingBagIcon,
  Trash2Icon,
} from "lucide-react";
import type { QuickAction, QuickActionId } from "@/lib/home-quick-actions";

// 1-12B — Grille d'accès rapides de l'accueil /app. Couleurs exclusivement
// via les jetons `--tenant-*` (1-12A, contraste AA calculé) : jamais de
// couleur cliente brute. Hors ligne (page déjà montée) : seules les actions
// servies sans réseau restent interactives ; les autres deviennent un bloc
// NON interactif (ni lien, ni bouton, hors ordre de tabulation) portant le
// texte « Indisponible hors connexion ».

const ICONS: Record<QuickActionId, typeof LayoutGridIcon> = {
  catalog: LayoutGridIcon,
  sales: ShoppingBagIcon,
  analytics: BarChart3Icon,
  trash: Trash2Icon,
  organization: Building2Icon,
  converter: ArrowLeftRightIcon,
};

const OFFLINE_UNAVAILABLE_LABEL = "Indisponible hors connexion";

const FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-(--tenant-accent-ring) focus-visible:ring-offset-2";
const CARD =
  "flex h-full min-h-28 w-full flex-col items-start gap-3 rounded-2xl border p-4 text-left motion-safe:transition-colors";
const CARD_INTERACTIVE = `${CARD} ${FOCUS} border-(--tenant-accent-border) bg-card hover:border-(--tenant-accent) hover:bg-(--tenant-accent-soft) active:bg-(--tenant-accent-soft)`;
// Carte principale (Catalogue) : fond plein `--tenant-accent`, texte
// `--tenant-accent-foreground` (navy ou blanc, ≥ 4,5:1). Pas d'opacité sur
// le fond au survol (le contraste calculé serait faussé) : anneau à la place.
const CARD_PRIMARY = `${CARD} ${FOCUS} border-transparent bg-(--tenant-accent) text-(--tenant-accent-foreground) hover:ring-2 hover:ring-(--tenant-accent-border) active:ring-2 active:ring-(--tenant-accent-border)`;
const CARD_UNAVAILABLE = `${CARD} cursor-not-allowed border-dashed bg-background text-muted-foreground`;

function CardBody({
  action,
  variant,
}: {
  action: QuickAction;
  variant: "primary" | "default" | "unavailable";
}) {
  const Icon = ICONS[action.id];
  const iconBlock =
    variant === "primary"
      ? "bg-(--tenant-accent-foreground)/15"
      : variant === "unavailable"
        ? "bg-muted"
        : "bg-(--tenant-accent) text-(--tenant-accent-foreground)";
  return (
    <>
      <span
        aria-hidden="true"
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${iconBlock}`}
      >
        <Icon className="h-5 w-5" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-base font-semibold leading-tight">
          {action.title}
        </span>
        <span
          className={`line-clamp-2 text-sm ${
            variant === "default" ? "text-muted-foreground" : ""
          }`}
        >
          {variant === "unavailable"
            ? OFFLINE_UNAVAILABLE_LABEL
            : action.description}
        </span>
      </span>
    </>
  );
}

export function HomeQuickActions({
  actions,
  offline,
  onOpenConverter,
}: {
  actions: QuickAction[];
  offline: boolean;
  onOpenConverter: () => void;
}) {
  return (
    <ul className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 lg:grid-cols-3">
      {actions.map((action) => {
        const primary = action.id === "catalog";
        const unavailable = offline && !action.availableOffline;
        const variant = unavailable
          ? "unavailable"
          : primary
            ? "primary"
            : "default";
        const className =
          variant === "unavailable"
            ? CARD_UNAVAILABLE
            : variant === "primary"
              ? CARD_PRIMARY
              : CARD_INTERACTIVE;
        const body = <CardBody action={action} variant={variant} />;

        let card: React.ReactNode;
        if (unavailable) {
          card = (
            <div className={className} data-quick-action-state="unavailable">
              {body}
            </div>
          );
        } else if (!action.href) {
          // Convertisseur : dialogue existant (aucune logique dupliquée).
          card = (
            <button
              type="button"
              onClick={onOpenConverter}
              className={className}
              aria-haspopup="dialog"
            >
              {body}
            </button>
          );
        } else if (offline) {
          // Hors ligne : ancre HTML simple (document /app/catalog servi par
          // le service worker), jamais de navigation RSC — cf. 1-11C.3a.
          card = (
            <a href={action.href} className={className}>
              {body}
            </a>
          );
        } else {
          card = (
            <Link href={action.href} prefetch={false} className={className}>
              {body}
            </Link>
          );
        }

        return (
          <li
            key={action.id}
            data-quick-action={action.id}
            className={primary ? "col-span-full lg:col-span-2" : undefined}
          >
            {card}
          </li>
        );
      })}
    </ul>
  );
}
