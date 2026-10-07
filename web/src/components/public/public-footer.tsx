import Link from "next/link";
import { Wordmark } from "@/components/brand/wordmark";
import { LANDING_NAV } from "@/components/landing/landing-nav";
import { HELP_PAGES, LEGAL_DOCUMENTS } from "@/lib/legal/site-identity";

// 1-16C — Pied de page commun à l'accueil et aux pages publiques. Les
// ancres de l'accueil sont préfixées par « / » hors de l'accueil. Le lien
// d'inscription suit le même flag d'affichage que le reste du site.
const linkClass =
  "inline-flex min-h-11 items-center rounded-sm text-sm text-[#3d4e66] hover:text-(--brand-navy) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-navy)";

function Column({
  title,
  id,
  children,
}: {
  title: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <nav aria-labelledby={id}>
      <h2 id={id} className="text-sm font-bold text-(--brand-navy)">
        {title}
      </h2>
      <ul className="mt-2 flex flex-col">{children}</ul>
    </nav>
  );
}

export function PublicFooter({ onHome = false }: { onHome?: boolean }) {
  const registrationEnabled =
    process.env.NEXT_PUBLIC_REGISTRATION_ENABLED === "true";
  const anchor = (href: string) => (onHome ? href : `/${href}`);

  return (
    <footer className="border-t border-(--brand-navy)/10 bg-white">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-[1.2fr_1fr_1fr_1.3fr]">
        <div>
          <Wordmark size="small" />
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-[#3d4e66]">
            Stock, ventes et équipe pour les commerces, depuis le téléphone.
          </p>
        </div>
        <Column title="Stock Master" id="pied-produit">
          {LANDING_NAV.map((item) => (
            <li key={item.href}>
              <a href={anchor(item.href)} className={linkClass}>
                {item.label}
              </a>
            </li>
          ))}
        </Column>
        <Column title="Aide et compte" id="pied-aide">
          {HELP_PAGES.map((page) => (
            <li key={page.href}>
              <Link href={page.href} className={linkClass}>
                {page.short}
              </Link>
            </li>
          ))}
          <li>
            <Link href="/auth/login" className={linkClass}>
              Connexion
            </Link>
          </li>
          {registrationEnabled && (
            <li>
              <Link href="/auth/register" className={linkClass}>
                Inscription
              </Link>
            </li>
          )}
        </Column>
        <Column title="Informations légales" id="pied-legal">
          {LEGAL_DOCUMENTS.map((doc) => (
            <li key={doc.href}>
              <Link href={doc.href} className={linkClass}>
                {doc.short}
              </Link>
            </li>
          ))}
        </Column>
      </div>
    </footer>
  );
}
