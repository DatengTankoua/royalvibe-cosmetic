import Link from "next/link";
import { Wordmark } from "@/components/brand/wordmark";

// 1-16C — En-tête des pages publiques secondaires (guide, contact, textes
// juridiques). Sans appel réseau ni état de session : la page reste
// identique en visite anonyme, session ouverte ou session limitée.
const linkClass =
  "inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium text-(--brand-navy)/80 hover:text-(--brand-navy) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-navy)";

export function PublicHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-(--brand-navy)/10 bg-white/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4">
        <Link
          href="/"
          className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--brand-navy)"
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
          </ul>
        </nav>
      </div>
    </header>
  );
}
