import Link from "next/link";

// 1-16C — Liens d'aide et d'information sous les formulaires de connexion
// et d'inscription. Simple navigation : ces liens ne valent PAS acceptation
// des conditions (aucune preuve n'est enregistrée, voir le rapport 1-16C).
const LINKS = [
  { href: "/guide", label: "Guide" },
  { href: "/contact", label: "Contact" },
  { href: "/conditions-utilisation", label: "Conditions d'utilisation" },
  { href: "/conditions-abonnement", label: "Conditions d'abonnement" },
  { href: "/confidentialite", label: "Confidentialité" },
] as const;

export function AuthLegalLinks() {
  return (
    <nav aria-label="Aide et informations" className="pt-2">
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs">
        {LINKS.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="inline-flex min-h-10 items-center rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
