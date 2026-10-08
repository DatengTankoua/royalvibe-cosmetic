import type { Metadata } from "next";
import Link from "next/link";
import {
  BarChart3Icon,
  BellRingIcon,
  ChevronDownIcon,
  FileSpreadsheetIcon,
  PackageIcon,
  ReceiptTextIcon,
  UsersIcon,
} from "lucide-react";
import { LandingHeader } from "@/components/landing/landing-header";
import { ProductPreview } from "@/components/landing/product-preview";
import { SessionCta } from "@/components/landing/session-cta";
import { PublicFooter } from "@/components/public/public-footer";
import { OfferConditions } from "@/components/subscription/subscription-offers";
import {
  SUBSCRIPTION_OFFERS,
  TRIAL_DAYS,
  formatFcfa,
  monthlyEquivalentXaf,
} from "@/lib/subscription-offers";
import { getServerT } from "@/i18n/server";
import { rich } from "@/i18n/rich";

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

// 1-16G : textes dans `public` (`landing.*`), durées dans `subscription`.
export async function generateMetadata(): Promise<Metadata> {
  const { t, lng } = await getServerT("public");
  const { t: ts } = await getServerT("subscription");
  const metaPrice = t("landing.meta.price", {
    monthly: formatFcfa(monthlyOffer?.totalXaf ?? 0, lng),
    best: formatFcfa(bestOffer?.totalXaf ?? 0, lng),
    term: bestOffer ? ts(`offers.term.${bestOffer.term}`) : "",
  });
  const title = t("landing.meta.title");
  return {
    title,
    description: `${t("landing.meta.description")} ${
      registrationEnabled
        ? t("landing.meta.trial", { days: TRIAL_DAYS, price: metaPrice })
        : t("landing.meta.subscription", { price: metaPrice })
    }`,
    openGraph: {
      title,
      description: `${t("landing.meta.ogDescription")}${
        registrationEnabled
          ? ` ${t("landing.meta.ogTrial", { days: TRIAL_DAYS })}`
          : ""
      }`,
    },
  };
}

const BENEFITS = [
  { icon: PackageIcon, key: "stock" },
  { icon: ReceiptTextIcon, key: "sales" },
  { icon: UsersIcon, key: "team" },
  { icon: BarChart3Icon, key: "analytics" },
  { icon: FileSpreadsheetIcon, key: "history" },
  { icon: BellRingIcon, key: "notifications" },
] as const;

const OFFLINE_STEPS = ["open", "sell", "sync"] as const;

const FAQ = [
  registrationEnabled ? "startOpen" : "startClosed",
  "sellers",
  "install",
  "network",
  "subscription",
  "privacy",
] as const;

const primaryCta =
  "inline-flex min-h-12 items-center justify-center rounded-lg bg-(--brand-orange) px-6 text-base font-semibold text-(--brand-navy) hover:bg-[#ff8533] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";
const primaryCtaOnLight =
  "inline-flex min-h-12 items-center justify-center rounded-lg bg-(--brand-solid) px-6 text-base font-semibold text-white hover:bg-(--brand-solid)/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-ink)";
const inlineLink =
  "rounded-sm font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2";

// Landing publique (1-10A) : ne déclenche aucun appel métier authentifié —
// seul `SessionCta` lit la session déjà en mémoire (jamais de fetch). Une
// session ouverte (y compris limitée) n'est jamais redirigée : l'en-tête
// propose « Ouvrir l'application », le shell /app décide ensuite.
export default async function LandingPage() {
  const { t, lng } = await getServerT("public");
  const { t: ts } = await getServerT("subscription");
  const fcfa = (amount: number) => formatFcfa(amount, lng);
  return (
    <div
      id="haut"
      className="flex flex-1 touch-manipulation flex-col bg-(--public-bg) text-(--brand-ink) [&_:target]:scroll-mt-20"
    >
      <a
        href="#contenu"
        className="sr-only z-40 rounded-md bg-(--public-bg) px-4 py-3 font-semibold text-(--brand-ink) focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:outline-2 focus:outline-(--brand-ink)"
      >
        {t("skipToContent")}
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
                {t("landing.hero.title")}
              </h1>
              <p className="mt-4 max-w-[34rem] text-base leading-relaxed text-pretty text-white/85 sm:mt-5 sm:text-lg">
                {t("landing.hero.text")}
              </p>

              <div className="mt-6 flex flex-col gap-3 sm:mt-8 sm:flex-row sm:items-center">
                {registrationEnabled ? (
                  <Link href="/auth/register" className={primaryCta}>
                    {t("landing.cta.startTrial")}
                  </Link>
                ) : (
                  <Link href="/auth/login" className={primaryCta}>
                    {t("landing.cta.login")}
                  </Link>
                )}
                <a
                  href="#tarifs"
                  className="inline-flex min-h-12 items-center justify-center rounded-lg border border-white/40 px-6 text-base font-semibold text-white hover:border-white hover:bg-(--public-bg)/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  {t("landing.cta.seePricing")}
                </a>
              </div>

              <p className="mt-5 text-sm leading-relaxed text-white/80">
                {registrationEnabled
                  ? rich(
                      t("landing.hero.trialNote", {
                        days: TRIAL_DAYS,
                        price: fcfa(lowestMonthlyEquivalent),
                        term: bestOffer
                          ? ts(`offers.term.${bestOffer.term}`)
                          : "",
                      }),
                      {
                        price: (chunk) => (
                          <strong className="font-semibold text-white tabular-nums">
                            {chunk}
                          </strong>
                        ),
                      },
                    )
                  : t("landing.hero.registrationClosed")}
              </p>
              {registrationEnabled && (
                <p className="mt-2 text-sm text-white/80">
                  {rich(t("landing.hero.alreadyRegistered"), {
                    login: (chunk) => (
                      <Link
                        href="/auth/login"
                        className={`${inlineLink} text-white focus-visible:outline-white`}
                      >
                        {chunk}
                      </Link>
                    ),
                  })}
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
            {t("landing.benefits.title")}
          </h2>
          <ul className="mt-10 grid gap-x-12 gap-y-10 sm:grid-cols-2">
            {BENEFITS.map(({ icon: Icon, key }) => (
              <li key={key} className="flex gap-4">
                <span
                  aria-hidden
                  className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-(--brand-orange)/12 text-(--brand-ink)"
                >
                  <Icon className="size-5" />
                </span>
                <div className="min-w-0">
                  <h3 className="text-lg font-bold">
                    {t(`landing.benefits.${key}.title`)}
                  </h3>
                  <p className="mt-1.5 leading-relaxed text-pretty text-(--public-muted)">
                    {t(`landing.benefits.${key}.text`)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-12 max-w-3xl border-t border-(--brand-ink)/10 pt-6 leading-relaxed text-(--public-muted)">
            {t("landing.benefits.alsoIncluded")}
          </p>
        </section>

        {/* Connexion instable : séquence réelle (outbox 1-11C), d'où la
        numérotation. */}
        <section
          id="hors-ligne"
          aria-labelledby="hors-ligne-title"
          className="bg-(--public-surface-2)"
        >
          <div className="mx-auto max-w-6xl px-4 py-16 sm:py-20">
            <h2
              id="hors-ligne-title"
              className="max-w-2xl text-3xl font-extrabold tracking-tight text-balance sm:text-4xl"
            >
              {t("landing.offline.title")}
            </h2>
            <ol className="mt-10 grid gap-8 md:grid-cols-3 md:gap-6">
              {OFFLINE_STEPS.map((key, index) => (
                <li key={key} className="flex gap-4 md:flex-col md:gap-3">
                  <span
                    aria-hidden
                    className="flex size-9 shrink-0 items-center justify-center rounded-full bg-(--brand-solid) text-sm font-bold text-white tabular-nums"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-lg font-bold">
                      {t(`landing.offline.steps.${key}.title`)}
                    </h3>
                    <p className="mt-1.5 leading-relaxed text-pretty text-(--public-muted)">
                      {t(`landing.offline.steps.${key}.text`)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-10 max-w-3xl text-sm leading-relaxed text-(--public-muted)">
              {t("landing.offline.note")}
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
                {t("landing.pricing.title")}
              </h2>
              <p className="mt-4 max-w-md leading-relaxed text-pretty text-(--public-muted)">
                {t("landing.pricing.text")}
              </p>
              {registrationEnabled && (
                <p className="mt-6 inline-block rounded-lg bg-(--brand-orange)/12 px-4 py-2.5 font-semibold">
                  {t("landing.pricing.trial", { days: TRIAL_DAYS })}
                </p>
              )}
            </div>

            <div>
              <ul className="divide-y divide-(--brand-ink)/10 overflow-hidden rounded-2xl border border-(--brand-ink)/15">
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
                        {ts(`offers.term.${offer.term}`)}
                        {recommended && (
                          <span className="rounded-full bg-(--brand-solid) px-2.5 py-0.5 text-xs font-semibold text-white">
                            {ts("offers.best")}
                          </span>
                        )}
                      </p>
                      <p className="text-right text-2xl font-extrabold tracking-tight whitespace-nowrap tabular-nums">
                        {fcfa(offer.totalXaf)}
                      </p>
                      <p className="col-span-2 text-sm text-(--public-muted) tabular-nums">
                        {offer.months > 1
                          ? offer.highlight === "freeMonths"
                            ? t("landing.pricing.equivalentFree", {
                                monthly: fcfa(monthlyEquivalentXaf(offer)),
                                saving: fcfa(offer.savingXaf),
                                highlight: ts("offers.highlight.freeMonths"),
                              })
                            : t("landing.pricing.equivalent", {
                                monthly: fcfa(monthlyEquivalentXaf(offer)),
                                saving: fcfa(offer.savingXaf),
                              })
                          : t("landing.pricing.monthByMonth")}
                      </p>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
                {registrationEnabled ? (
                  <Link href="/auth/register" className={primaryCtaOnLight}>
                    {t("landing.cta.startTrial")}
                  </Link>
                ) : (
                  <p className="text-sm text-(--public-muted)">
                    {rich(t("landing.pricing.closed"), {
                      login: (chunk) => (
                        <Link
                          href="/auth/login"
                          className={`${inlineLink} focus-visible:outline-(--brand-ink)`}
                        >
                          {chunk}
                        </Link>
                      ),
                    })}
                  </p>
                )}
              </div>
              <div className="mt-8 border-t border-(--brand-ink)/10 pt-6 text-sm [&_li]:text-(--public-muted)">
                <OfferConditions />
              </div>
            </div>
          </div>
        </section>

        {/* FAQ : <details> natif (clavier, lecteurs d'écran, sans JS). */}
        <section
          id="questions"
          aria-labelledby="questions-title"
          className="border-t border-(--brand-ink)/10"
        >
          <div className="mx-auto max-w-3xl px-4 py-16 sm:py-20">
            <h2
              id="questions-title"
              className="text-3xl font-extrabold tracking-tight sm:text-4xl"
            >
              {t("landing.faq.title")}
            </h2>
            <div className="mt-8 divide-y divide-(--brand-ink)/10 border-y border-(--brand-ink)/10">
              {FAQ.map((key) => (
                <details key={key} className="group">
                  <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-md py-4 text-left text-lg font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-ink) [&::-webkit-details-marker]:hidden">
                    {t(`landing.faq.${key}.question`)}
                    <ChevronDownIcon
                      aria-hidden
                      className="size-5 shrink-0 motion-safe:transition-transform group-open:rotate-180"
                    />
                  </summary>
                  <p className="pb-5 leading-relaxed text-pretty text-(--public-muted)">
                    {key === "subscription"
                      ? t(
                          registrationEnabled
                            ? "landing.faq.subscription.answerTrial"
                            : "landing.faq.subscription.answer",
                          { days: TRIAL_DAYS },
                        )
                      : t(`landing.faq.${key}.answer`, { days: TRIAL_DAYS })}
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
                ? t("landing.final.titleOpen")
                : t("landing.final.titleClosed")}
            </h2>
            <p className="mt-4 max-w-xl leading-relaxed text-white/85">
              {registrationEnabled
                ? t("landing.final.textOpen", { days: TRIAL_DAYS })
                : t("landing.final.textClosed")}
            </p>
            <div className="mt-8">
              <SessionCta variant="final" />
            </div>
          </div>
        </section>
      </div>

      <PublicFooter onHome />
    </div>
  );
}
