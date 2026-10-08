import Link from "next/link";
import { PublicFooter } from "@/components/public/public-footer";
import { PublicHeader } from "@/components/public/public-header";
import type { PublicDocument } from "@/lib/legal/site-identity";
import { getServerT } from "@/i18n/server";
import { rich } from "@/i18n/rich";

// 1-16C — Gabarit des textes longs publics (juridiques et guide) : en-tête
// et pied communs, sommaire généré depuis les sections (un seul niveau
// d'ancres, titres h2 hiérarchisés), lien d'évitement. 1-16C.1 : plus de
// bandeau « projet » affiché ; le statut reste dans `site-identity.ts`
// (documents non indexés tant qu'ils ne sont pas validés).
// Rendu serveur, aucune donnée de session. 1-16G : textes du gabarit dans
// `legal` (`document.*`), contenu fourni dans la langue de la requête.

export interface DocumentSection {
  id: string;
  title: string;
  content: React.ReactNode;
}

// Typographie des corps de texte (pas de plugin « typography » dans le
// projet) : sélecteurs descendants limités au conteneur `.doc-body`.
const bodyClass =
  "doc-body text-base leading-relaxed text-(--public-body) [&_a]:font-medium [&_a]:text-(--brand-ink) [&_a]:underline [&_a]:underline-offset-4 [&_a]:rounded-sm [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-(--brand-ink) [&_h3]:mt-6 [&_h3]:text-lg [&_h3]:font-bold [&_h3]:text-(--brand-ink) [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_ol]:mt-3 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5 [&_strong]:font-semibold [&_strong]:text-(--brand-ink) [&_table]:mt-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm [&_th]:border-b [&_th]:border-(--brand-ink)/20 [&_th]:py-2 [&_th]:pr-3 [&_th]:text-left [&_th]:align-top [&_th]:font-semibold [&_td]:border-b [&_td]:border-(--brand-ink)/10 [&_td]:py-2 [&_td]:pr-3 [&_td]:align-top";

export async function DocumentPage({
  title,
  intro,
  doc,
  sections,
}: {
  title: string;
  intro: React.ReactNode;
  /** Absent pour les pages d'aide (pas de version juridique). */
  doc?: PublicDocument;
  sections: DocumentSection[];
}) {
  const { t, lng } = await getServerT("legal");
  return (
    <div className="flex flex-1 flex-col bg-(--public-bg) text-(--brand-ink)">
      <a
        href="#contenu"
        className="sr-only z-40 rounded-md bg-(--public-bg) px-4 py-3 font-semibold text-(--brand-ink) focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:outline-2 focus:outline-(--brand-ink)"
      >
        {t("document.skipToContent")}
      </a>
      <PublicHeader />

      <div
        id="contenu"
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-4 pt-8 pb-16 outline-none sm:pt-12"
        data-legal-document={doc?.id}
        data-legal-version={doc?.version}
      >
        {/* 1-16C.2 : `data-legal-text` délimite le texte PRÉSENTÉ d'un
        document versionné (titre, version, introduction, sections), extrait
        du HTML prérendu et archivé par `web/scripts/legal-archive.mjs`. Le
        sommaire (dérivé des titres) et les liens d'aide en sont exclus. */}
        <div className="max-w-3xl" data-legal-text={doc ? "" : undefined}>
          <h1 className="text-3xl font-extrabold tracking-tight text-balance sm:text-4xl">
            {title}
          </h1>
          {doc && (
            <p className="mt-3 text-sm text-(--public-muted)">
              {t("document.version", {
                version: doc.version,
                date: doc.updatedAt[lng],
              })}
            </p>
          )}
          <div className="mt-5 text-lg leading-relaxed text-pretty text-(--public-body)">
            {intro}
          </div>
        </div>

        <div className="mt-10 grid gap-10 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-14">
          <nav
            aria-labelledby="sommaire-titre"
            className="h-fit rounded-xl border border-(--brand-ink)/10 bg-(--public-surface) p-4 lg:sticky lg:top-24"
          >
            <h2 id="sommaire-titre" className="text-sm font-bold">
              {t("document.toc")}
            </h2>
            <ol className="mt-2 space-y-0.5 text-sm">
              {sections.map((section, index) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className="flex min-h-10 items-start gap-2 rounded-md px-1 py-2 text-(--public-muted) hover:text-(--brand-ink) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--brand-ink)"
                  >
                    <span
                      className="w-5 shrink-0 text-right tabular-nums"
                      aria-hidden
                    >
                      {index + 1}.
                    </span>
                    <span className="min-w-0">{section.title}</span>
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <div className="min-w-0 max-w-3xl">
            <div data-legal-text={doc ? "" : undefined}>
              {sections.map((section, index) => (
                <section
                  key={section.id}
                  id={section.id}
                  aria-labelledby={`${section.id}-titre`}
                  className="scroll-mt-24 border-t border-(--brand-ink)/10 pt-8 pb-4 first:border-t-0 first:pt-0"
                >
                  <h2
                    id={`${section.id}-titre`}
                    className="text-2xl font-bold tracking-tight text-balance"
                  >
                    <span className="tabular-nums">{index + 1}.</span>{" "}
                    {section.title}
                  </h2>
                  <div className={bodyClass}>{section.content}</div>
                </section>
              ))}
            </div>
            <p className="mt-10 text-sm text-(--public-muted)">
              {rich(t("document.question"), {
                contact: (chunk) => (
                  <Link
                    href="/contact"
                    className="font-medium text-(--brand-ink) underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-ink)"
                  >
                    {chunk}
                  </Link>
                ),
              })}
            </p>
          </div>
        </div>
      </div>

      <PublicFooter />
    </div>
  );
}
