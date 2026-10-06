import type { Metadata } from "next";
import Link from "next/link";
import {
  BarChart3Icon,
  ChevronDownIcon,
  PackageIcon,
  ReceiptTextIcon,
  UsersIcon,
} from "lucide-react";
import { Wordmark } from "@/components/brand/wordmark";
import { LandingHeader } from "@/components/landing/landing-header";
import { LANDING_NAV } from "@/components/landing/landing-nav";
import { ProductPreview } from "@/components/landing/product-preview";
import { SessionCta } from "@/components/landing/session-cta";
import { OfferConditions } from "@/components/subscription/subscription-offers";
import {
  SUBSCRIPTION_OFFERS,
  TRIAL_DAYS,
  formatFcfa,
  monthlyEquivalentXaf,
} from "@/lib/subscription-offers";

// 1-16B — Accueil public. Tous les contenus décrivent des capacités LIVRÉES
// (vérifiées dans le code au moment du lot, voir
// docs/architecture/phase-1-16b-marketing-homepage.md) : aucun témoignage,
// chiffre client, partenariat ni moyen de paiement annoncé. Tarifs et durée
// de l'essai lus dans `lib/subscription-offers.ts` (miroir des montants de
// l'API, `subscription-pricing.ts` et `TRIAL_DURATION_MS`).

// Même flag d'affichage que la connexion/inscription (0B.5), figé au build ;
// le backend reste l'autorité finale. Inscription fermée : aucun texte ne
// présente l'essai comme accessible (métadonnées et FAQ comprises).
const registrationEnabled =
  process.env.NEXT_PUBLIC_REGISTRATION_ENABLED === "true";

const lowestMonthlyEquivalent = Math.min(
  ...SUBSCRIPTION_OFFERS.map(monthlyEquivalentXaf),
);
// Formule mise en avant : la moins chère en équivalent mensuel (12 mois).
// Dérivée des données, jamais de RECOMMENDED_TERM importé d'un module
// "use client" (référence client côté serveur, pas la valeur).
const bestOffer = SUBSCRIPTION_OFFERS.find(
  (offer) => monthlyEquivalentXaf(offer) === lowestMonthlyEquivalent,
);
const monthlyOffer = SUBSCRIPTION_OFFERS.find((offer) => offer.months === 1);
const metaPrice = `${formatFcfa(monthlyOffer?.totalXaf ?? 0)} par mois, ou ${formatFcfa(bestOffer?.totalXaf ?? 0)} pour ${bestOffer?.label}`;

export const metadata: Metadata = {
  title: "Stock Master — Stock et ventes de votre commerce, sur téléphone",
  description: `Suivez votre stock, enregistrez vos ventes, travaillez avec vos vendeurs et comprenez votre activité. ${
    registrationEnabled
      ? `Essai gratuit de ${TRIAL_DAYS} jours, puis ${metaPrice}.`
      : `Abonnement de ${metaPrice}.`
  }`,
  openGraph: {
    title: "Stock Master — Stock et ventes de votre commerce, sur téléphone",
    description: `Stock, ventes, équipe et analyses pour les commerces et PME.${
      registrationEnabled ? ` Essai gratuit de ${TRIAL_DAYS} jours.` : ""
    }`,
  },
};

const benefits = [
  {
    icon: PackageIcon,
    title: "Suivre votre stock",
    text: "Rangez vos produits par rayon. Chaque vente fait baisser le stock restant, et l'application vous signale les produits en stock faible ou épuisés.",
  },
  {
    icon: ReceiptTextIcon,
    title: "Enregistrer vos ventes",
    text: "Choisissez le produit, la quantité et le prix, puis validez. Chaque vente garde sa date et le nom du vendeur.",
  },
  {
    icon: UsersIcon,
    title: "Travailler avec votre équipe",
    text: "Invitez vos vendeurs avec un lien et choisissez ce que chacun peut faire : vendre, gérer le catalogue, voir les chiffres. Le prix ne change pas avec le nombre de vendeurs.",
  },
  {
    icon: BarChart3Icon,
    title: "Comprendre votre activité",
    text: "La page Analyse calcule votre chiffre d'affaires, votre bénéfice et votre marge, et classe vos produits et vos vendeurs.",
  },
];

const offlineSteps = [
  {
    title: "Ouvrez l'application avec du réseau",
    text: "Le téléphone garde votre catalogue et votre droit de vendre pendant 72 heures.",
  },
  {
    title: "Vendez même sans connexion",
    text: "Chaque vente est enregistrée sur l'appareil et marquée « en attente ».",
  },
  {
    title: "Le réseau revient, les ventes partent",
    text: "L'envoi est automatique. Le serveur vérifie le stock ; si une vente pose problème, elle vous est signalée pour que vous décidiez.",
  },
];

const faq = [
  registrationEnabled
    ? {
        question: "Comment je commence ?",
        answer: `Créez votre compte avec le nom de votre commerce, puis confirmez votre adresse e-mail grâce au lien reçu. Connectez-vous, ajoutez vos rayons et vos produits : vous pouvez enregistrer vos premières ventes. L'essai gratuit de ${TRIAL_DAYS} jours commence à la création du commerce.`,
      }
    : {
        question: "Comment je commence ?",
        answer:
          "Les inscriptions en ligne sont momentanément fermées. Si votre commerce a déjà un compte, connectez-vous. Un vendeur rejoint le commerce avec le lien d'invitation que lui transmet le propriétaire.",
      },
  {
    question: "Mes vendeurs peuvent-ils utiliser l'application ?",
    answer:
      "Oui. Depuis l'espace Organisation, créez une invitation : vous obtenez un lien à transmettre au vendeur, par SMS ou messagerie par exemple. Il crée son accès avec ce lien. Chaque membre peut enregistrer des ventes ; vous ajoutez les autres droits un par un.",
  },
  {
    question: "Faut-il installer une application sur le téléphone ?",
    answer:
      "Non. Stock Master s'ouvre dans le navigateur d'un téléphone, d'une tablette ou d'un ordinateur, sans passer par un magasin d'applications. Vous avez la possibilité de telecharger l'application depuis le navigateurpour un accès plus rapide. Une fois téléchargée, vous pouvez l'ouvrir directement depuis votre écran d'accueil.",
  },
  {
    question: "Et si la connexion est mauvaise ?",
    answer:
      "Si vous avez ouvert l'application avec du réseau dans les 72 dernières heures, vous pouvez continuer à enregistrer des ventes sans connexion. Elles restent sur l'appareil jusqu'à 14 jours et partent dès que le réseau revient. Ajouter des produits, consulter les analyses ou gérer l'équipe demande une connexion.",
  },
  {
    question: "Comment fonctionne l'abonnement ?",
    answer: `${registrationEnabled ? `Après les ${TRIAL_DAYS} jours d'essai, le` : "Le"} propriétaire choisit une durée de 1, 3, 6 ou 12 mois depuis l'espace Abonnement. Il n'y a aucun prélèvement automatique : chaque renouvellement est volontaire. Le prix couvre tout le commerce, quel que soit le nombre de vendeurs.`,
  },
  {
    question: "Les autres commerces voient-ils mes données ?",
    answer:
      "Non. Chaque commerce a son propre espace. Seuls les membres que vous invitez y accèdent, avec les droits que vous leur donnez.",
  },
];

const primaryCta =
  "inline-flex min-h-12 items-center justify-center rounded-lg bg-(--brand-orange) px-6 text-base font-semibold text-(--brand-navy) hover:bg-[#ff8533] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";
const primaryCtaOnLight =
  "inline-flex min-h-12 items-center justify-center rounded-lg bg-(--brand-navy) px-6 text-base font-semibold text-white hover:bg-(--brand-navy)/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-navy)";
const inlineLink =
  "rounded-sm font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2";

// Landing publique (1-10A) : ne déclenche aucun appel métier authentifié —
// seul `SessionCta` lit la session déjà en mémoire (jamais de fetch). Une
// session ouverte (y compris limitée) n'est jamais redirigée : l'en-tête
// propose « Ouvrir l'application », le shell /app décide ensuite.
export default function LandingPage() {
  return (
    <div
      id="haut"
      className="flex flex-1 touch-manipulation flex-col bg-white text-(--brand-navy) [&_:target]:scroll-mt-20"
    >
      <a
        href="#contenu"
        className="sr-only z-40 rounded-md bg-white px-4 py-3 font-semibold text-(--brand-navy) focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:outline-2 focus:outline-(--brand-navy)"
      >
        Aller au contenu
      </a>
      <LandingHeader />

      <div id="contenu" tabIndex={-1} className="flex-1 outline-none">
        {/* Première section : promesse, action principale, vraies captures. */}
        <section
          aria-labelledby="hero-title"
          className="overflow-hidden bg-(--brand-navy) text-white"
        >
          <div className="mx-auto grid max-w-6xl gap-10 px-4 pt-8 pb-12 sm:pt-14 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-8 lg:pt-16 lg:pb-16">
            <div className="max-w-xl">
              <h1
                id="hero-title"
                className="text-[2.1rem] leading-[1.08] font-extrabold tracking-tight text-balance sm:text-5xl lg:text-[3.4rem]"
              >
                Suivez votre stock et vos ventes depuis votre téléphone
              </h1>
              <p className="mt-4 max-w-[34rem] text-base leading-relaxed text-pretty text-white/85 sm:mt-5 sm:text-lg">
                Stock Master remplace le cahier de la boutique. Ajoutez vos
                produits, enregistrez chaque vente et voyez ce qui reste en
                rayon et ce que vous gagnez, seul ou avec vos vendeurs.
              </p>

              <div className="mt-6 flex flex-col gap-3 sm:mt-8 sm:flex-row sm:items-center">
                {registrationEnabled ? (
                  <Link href="/auth/register" className={primaryCta}>
                    Commencer mon essai gratuit
                  </Link>
                ) : (
                  <Link href="/auth/login" className={primaryCta}>
                    Se connecter
                  </Link>
                )}
                <a
                  href="#tarifs"
                  className="inline-flex min-h-12 items-center justify-center rounded-lg border border-white/40 px-6 text-base font-semibold text-white hover:border-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  Voir les tarifs
                </a>
              </div>

              <p className="mt-5 text-sm leading-relaxed text-white/80">
                {registrationEnabled ? (
                  <>
                    {TRIAL_DAYS} jours d&apos;essai gratuit, sans carte
                    bancaire. Ensuite, à partir de{" "}
                    <strong className="font-semibold text-white tabular-nums">
                      {formatFcfa(lowestMonthlyEquivalent)}&nbsp;par mois
                    </strong>{" "}
                    avec la formule {bestOffer?.label}.
                  </>
                ) : (
                  "Les inscriptions sont momentanément fermées. Les commerces déjà inscrits peuvent se connecter."
                )}
              </p>
              {registrationEnabled && (
                <p className="mt-2 text-sm text-white/80">
                  Déjà inscrit ?{" "}
                  <Link
                    href="/auth/login"
                    className={`${inlineLink} text-white focus-visible:outline-white`}
                  >
                    Se connecter
                  </Link>
                </p>
              )}
            </div>

            <ProductPreview />
          </div>
        </section>

        {/* Bénéfices : quatre usages concrets, sans cartes identiques. */}
        <section
          id="fonctionnalites"
          aria-labelledby="fonctionnalites-title"
          className="mx-auto max-w-6xl px-4 py-16 sm:py-20"
        >
          <h2
            id="fonctionnalites-title"
            className="max-w-2xl text-3xl font-extrabold tracking-tight text-balance sm:text-4xl"
          >
            Tout ce qu&apos;il faut pour tenir la boutique
          </h2>
          <ul className="mt-10 grid gap-x-12 gap-y-10 sm:grid-cols-2">
            {benefits.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-4">
                <span
                  aria-hidden
                  className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-(--brand-orange)/12 text-(--brand-navy)"
                >
                  <Icon className="size-5" />
                </span>
                <div className="min-w-0">
                  <h3 className="text-lg font-bold">{title}</h3>
                  <p className="mt-1.5 leading-relaxed text-pretty text-[#3d4e66]">
                    {text}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-12 max-w-3xl border-t border-(--brand-navy)/10 pt-6 leading-relaxed text-[#3d4e66]">
            Aussi inclus : la corbeille pour récupérer un produit supprimé, le
            convertisseur euro ↔ franc CFA, le logo et la couleur de votre
            commerce, et un centre de notifications dans l&apos;application.
          </p>
        </section>

        {/* Connexion instable : séquence réelle (outbox 1-11C), d'où la
        numérotation. */}
        <section
          id="hors-ligne"
          aria-labelledby="hors-ligne-title"
          className="bg-[#eef3f9]"
        >
          <div className="mx-auto max-w-6xl px-4 py-16 sm:py-20">
            <h2
              id="hors-ligne-title"
              className="max-w-2xl text-3xl font-extrabold tracking-tight text-balance sm:text-4xl"
            >
              Le réseau coupe ? Vous continuez à vendre.
            </h2>
            <ol className="mt-10 grid gap-8 md:grid-cols-3 md:gap-6">
              {offlineSteps.map(({ title, text }, index) => (
                <li key={title} className="flex gap-4 md:flex-col md:gap-3">
                  <span
                    aria-hidden
                    className="flex size-9 shrink-0 items-center justify-center rounded-full bg-(--brand-navy) text-sm font-bold text-white tabular-nums"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-lg font-bold">{title}</h3>
                    <p className="mt-1.5 leading-relaxed text-pretty text-[#3d4e66]">
                      {text}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-10 max-w-3xl text-sm leading-relaxed text-[#3d4e66]">
              Sans réseau, seule la vente est possible. Ajouter des produits,
              consulter les analyses ou gérer l&apos;équipe demande une
              connexion. Les ventes en attente restent sur l&apos;appareil
              jusqu&apos;à 14 jours.
            </p>
          </div>
        </section>

        {/* Tarifs : montants de lib/subscription-offers.ts, présentés comme
        une liste de prix (total d'abord, équivalent mensuel ensuite). */}
        <section
          id="tarifs"
          aria-labelledby="tarifs-title"
          className="mx-auto max-w-6xl px-4 py-16 sm:py-20"
        >
          <div className="grid gap-10 lg:grid-cols-[1fr_1.25fr] lg:gap-16">
            <div>
              <h2
                id="tarifs-title"
                className="text-3xl font-extrabold tracking-tight text-balance sm:text-4xl"
              >
                Un abonnement, la durée de votre choix
              </h2>
              <p className="mt-4 max-w-md leading-relaxed text-pretty text-[#3d4e66]">
                Toutes les fonctionnalités, pour tout le commerce. Le montant
                indiqué est le total payé pour la durée choisie.
              </p>
              {registrationEnabled && (
                <p className="mt-6 inline-block rounded-lg bg-(--brand-orange)/12 px-4 py-2.5 font-semibold">
                  {TRIAL_DAYS} jours d&apos;essai gratuit, sans carte bancaire
                </p>
              )}
            </div>

            <div>
              <ul className="divide-y divide-(--brand-navy)/10 overflow-hidden rounded-2xl border border-(--brand-navy)/15">
                {SUBSCRIPTION_OFFERS.map((offer) => {
                  const recommended = offer.term === bestOffer?.term;
                  return (
                    <li
                      key={offer.term}
                      className={`grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 px-5 py-5 ${
                        recommended
                          ? "border-l-4 border-l-(--brand-orange) bg-(--brand-orange)/[0.06]"
                          : "border-l-4 border-l-transparent"
                      }`}
                    >
                      <p className="flex flex-wrap items-center gap-2 text-lg font-bold">
                        {offer.label}
                        {recommended && (
                          <span className="rounded-full bg-(--brand-navy) px-2.5 py-0.5 text-xs font-semibold text-white">
                            Le plus avantageux
                          </span>
                        )}
                      </p>
                      <p className="text-right text-2xl font-extrabold tracking-tight whitespace-nowrap tabular-nums">
                        {formatFcfa(offer.totalXaf)}
                      </p>
                      <p className="col-span-2 text-sm text-[#3d4e66] tabular-nums">
                        {offer.months > 1
                          ? `Soit ${formatFcfa(monthlyEquivalentXaf(offer))} par mois et ${formatFcfa(offer.savingXaf)} d'économie par rapport au paiement mensuel${
                              offer.highlight &&
                              !offer.highlight.includes("économie")
                                ? `, soit ${offer.highlight}`
                                : ""
                            }.`
                          : "Paiement mois par mois."}
                      </p>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
                {registrationEnabled ? (
                  <Link href="/auth/register" className={primaryCtaOnLight}>
                    Commencer mon essai gratuit
                  </Link>
                ) : (
                  <p className="text-sm text-[#3d4e66]">
                    Les inscriptions sont momentanément fermées.{" "}
                    <Link
                      href="/auth/login"
                      className={`${inlineLink} focus-visible:outline-(--brand-navy)`}
                    >
                      Se connecter
                    </Link>
                  </p>
                )}
              </div>
              <div className="mt-8 border-t border-(--brand-navy)/10 pt-6 text-sm [&_li]:text-[#3d4e66]">
                <OfferConditions />
              </div>
            </div>
          </div>
        </section>

        {/* FAQ : <details> natif (clavier, lecteurs d'écran, sans JS). */}
        <section
          id="questions"
          aria-labelledby="questions-title"
          className="border-t border-(--brand-navy)/10"
        >
          <div className="mx-auto max-w-3xl px-4 py-16 sm:py-20">
            <h2
              id="questions-title"
              className="text-3xl font-extrabold tracking-tight sm:text-4xl"
            >
              Questions fréquentes
            </h2>
            <div className="mt-8 divide-y divide-(--brand-navy)/10 border-y border-(--brand-navy)/10">
              {faq.map(({ question, answer }) => (
                <details key={question} className="group">
                  <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-md py-4 text-left text-lg font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-navy) [&::-webkit-details-marker]:hidden">
                    {question}
                    <ChevronDownIcon
                      aria-hidden
                      className="size-5 shrink-0 motion-safe:transition-transform group-open:rotate-180"
                    />
                  </summary>
                  <p className="pb-5 leading-relaxed text-pretty text-[#3d4e66]">
                    {answer}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Appel final : session ouverte → « Ouvrir l'application ». */}
        <section
          aria-labelledby="final-title"
          className="bg-(--brand-navy) text-white"
        >
          <div className="mx-auto max-w-6xl px-4 py-16 sm:py-20">
            <h2
              id="final-title"
              className="max-w-2xl text-3xl font-extrabold tracking-tight text-balance sm:text-4xl"
            >
              {registrationEnabled
                ? "Essayez Stock Master dans votre boutique"
                : "Retrouvez votre boutique dans Stock Master"}
            </h2>
            <p className="mt-4 max-w-xl leading-relaxed text-white/85">
              {registrationEnabled
                ? `Créez votre compte, ajoutez quelques produits et enregistrez vos premières ventes. Vous avez ${TRIAL_DAYS} jours gratuits pour vous faire un avis.`
                : "Connectez-vous pour retrouver votre catalogue, vos ventes et vos analyses."}
            </p>
            <div className="mt-8">
              <SessionCta variant="final" />
            </div>
          </div>
        </section>
      </div>

      <footer className="border-t border-(--brand-navy)/10 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 md:flex-row md:items-center md:justify-between">
          <Wordmark size="small" />
          <nav aria-label="Pied de page">
            <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
              {LANDING_NAV.map((item) => (
                <li key={item.href}>
                  <a
                    href={item.href}
                    className="inline-flex min-h-11 items-center rounded-sm text-[#3d4e66] hover:text-(--brand-navy) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-navy)"
                  >
                    {item.label}
                  </a>
                </li>
              ))}
              <li>
                <Link
                  href="/auth/login"
                  className="inline-flex min-h-11 items-center rounded-sm text-[#3d4e66] hover:text-(--brand-navy) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-navy)"
                >
                  Connexion
                </Link>
              </li>
              {registrationEnabled && (
                <li>
                  <Link
                    href="/auth/register"
                    className="inline-flex min-h-11 items-center rounded-sm text-[#3d4e66] hover:text-(--brand-navy) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-navy)"
                  >
                    Inscription
                  </Link>
                </li>
              )}
            </ul>
          </nav>
        </div>
      </footer>
    </div>
  );
}
