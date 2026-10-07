import Link from "next/link";
import { Wordmark } from "@/components/brand/wordmark";
import { ThemeToggle } from "@/components/theme/theme-toggle";

// 1-16C — En-tête des pages publiques secondaires (guide, contact, textes
// juridiques). Sans appel réseau ni état de session : la page reste
// identique en visite anonyme, session ouverte ou session limitée.
// 1-16F : contrôle du thème en fin d'en-tête.
export const PUBLIC_THEME_TOGGLE_CLASS =
  "inline-flex size-11 items-center justify-center rounded-lg text-(--brand-ink) hover:bg-(--brand-ink)/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-ink) [&_svg]:size-5";
const linkClass =
  "inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium text-(--brand-ink)/80 hover:text-(--brand-ink) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-ink)";

export function PublicHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-(--brand-ink)/10 bg-(--public-bg)/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4">
        <Link
          href="/"
          className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--brand-ink)"
          aria-label="Stock Master, retour à l'accueil"
        >
          <Wordmark size="small" priority />
        </Link>
        <nav aria-label="Aide">
          <ul className="flex items-center gap-1 sm:gap-3">
            <li>
              <Link href="/guide" className={linkClass}>
                Guide
              </Link>
            </li>
            <li>
              <Link href="/contact" className={linkClass}>
                Contact
              </Link>
            </li>
            <li>
              <ThemeToggle className={PUBLIC_THEME_TOGGLE_CLASS} />
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
