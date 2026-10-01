"use client";

import Link from "next/link";
import { CheckIcon } from "lucide-react";
import {
  SUBSCRIPTION_OFFERS,
  formatFcfa,
  monthlyEquivalentXaf,
  type SubscriptionOffer,
  type SubscriptionTerm,
} from "@/lib/subscription-offers";

// 1-14C.2 — Grille des quatre durées de l'offre unique. Montant TOTAL de la
// durée en premier ; équivalent mensuel explicitement présenté comme tel.
// Aucune action de paiement ici : présentation uniquement.

function OfferBody({ offer }: { offer: SubscriptionOffer }) {
  return (
    <>
      <span className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{offer.label}</span>
        {offer.highlight && (
          <span className="rounded-full bg-(--brand-orange)/15 px-2 py-0.5 text-[11px] font-semibold text-(--brand-navy)">
            {offer.highlight}
          </span>
        )}
      </span>
      <span className="mt-2 block text-2xl font-bold tracking-tight">
        {formatFcfa(offer.totalXaf)}
      </span>
      <span className="block text-xs text-muted-foreground">
        pour {offer.label}
        {offer.months > 1 &&
          ` · soit ${formatFcfa(monthlyEquivalentXaf(offer))} / mois en équivalent mensuel`}
      </span>
      <span className="mt-2 block text-xs font-medium">
        {offer.savingXaf > 0
          ? `Économie de ${formatFcfa(offer.savingXaf)} par rapport au paiement mensuel`
          : "Paiement mensuel"}
      </span>
    </>
  );
}

/** Durée mise en avant sur la page publique (meilleur rapport). */
export const RECOMMENDED_TERM: SubscriptionTerm = "annual";

const PUBLIC_INCLUDED = [
  "Catalogue, stock et ventes",
  "Convertisseur EUR ↔ FCFA",
  "Analyses et corbeille",
  "Membres et permissions",
];

/**
 * Grille publique : quatre cartes, la durée recommandée mise en avant.
 * `cta` (inscription ouverte uniquement) ajoute un bouton d'essai par
 * carte — l'essai ne dépend pas de la durée : aucune durée n'est réservée
 * ni attribuée depuis le navigateur.
 */
export function OfferGrid({ cta }: { cta?: { href: string; label: string } }) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-stretch">
      {SUBSCRIPTION_OFFERS.map((offer) => {
        const recommended = offer.term === RECOMMENDED_TERM;
        return (
          <li
            key={offer.term}
            className={`relative flex flex-col rounded-2xl border bg-background p-5 shadow-sm transition-shadow hover:shadow-md ${
              recommended
                ? "border-(--brand-navy) ring-2 ring-(--brand-navy) lg:-my-2 lg:py-7"
                : "border-border"
            }`}
          >
            {recommended && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-(--brand-navy) px-3 py-1 text-xs font-semibold whitespace-nowrap text-white">
                Le plus avantageux
              </span>
            )}
            <OfferBody offer={offer} />
            {/* `mb-5` + `mt-auto` du bouton : boutons alignés en bas de
            toutes les cartes, quelle que soit la hauteur du texte. */}
            <ul className="mt-4 mb-5 space-y-1.5 text-xs text-muted-foreground">
              {PUBLIC_INCLUDED.map((item) => (
                <li key={item} className="flex items-start gap-1.5">
                  <CheckIcon
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--brand-navy)"
                    aria-hidden
                  />
                  {item}
                </li>
              ))}
            </ul>
            {cta && (
              <Link
                href={cta.href}
                className={`mt-auto inline-flex h-11 items-center justify-center rounded-lg px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-navy) ${
                  recommended
                    ? "bg-(--brand-navy) text-white hover:bg-(--brand-navy)/90"
                    : "border border-(--brand-navy) text-(--brand-navy) hover:bg-(--brand-navy)/5"
                }`}
                aria-label={`${cta.label} — formule ${offer.label}`}
              >
                {cta.label}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Sélection d'une durée (renouvellement) : groupe radio accessible. */
export function OfferSelector({
  selected,
  onSelect,
}: {
  selected: SubscriptionTerm | null;
  onSelect: (term: SubscriptionTerm) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Durée du renouvellement"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      {SUBSCRIPTION_OFFERS.map((offer) => {
        const checked = selected === offer.term;
        return (
          <button
            key={offer.term}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onSelect(offer.term)}
            className={`relative rounded-xl border p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
              checked
                ? "border-primary bg-muted"
                : "border-border hover:bg-muted"
            }`}
          >
            {checked && (
              <CheckIcon
                className="absolute right-3 bottom-3 h-4 w-4"
                aria-hidden
              />
            )}
            <OfferBody offer={offer} />
          </button>
        );
      })}
    </div>
  );
}

/** Rappel commun des conditions validées. */
export function OfferConditions() {
  return (
    <ul className="space-y-1 text-sm text-muted-foreground">
      <li>
        Mêmes fonctionnalités pour toutes les durées, selon les droits de chaque
        membre.
      </li>
      <li>Abonnement par commerce, sans supplément par vendeur.</li>
      <li>
        Aucun prélèvement automatique : chaque renouvellement est volontaire.
      </li>
    </ul>
  );
}
