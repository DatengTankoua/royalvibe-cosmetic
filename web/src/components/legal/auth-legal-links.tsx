"use client";

import Link from "next/link";
import { useT } from "next-i18next/client";

// 1-16C — Liens d'aide et d'information sous les formulaires de connexion
// et d'inscription. Simple navigation : ces liens ne valent PAS acceptation
// des conditions (aucune preuve n'est enregistrée, voir le rapport 1-16C).
const LINKS = [
  { href: "/guide", key: "guide" },
  { href: "/contact", key: "contact" },
  { href: "/conditions-utilisation", key: "terms" },
  { href: "/conditions-abonnement", key: "subscriptionTerms" },
  { href: "/confidentialite", key: "privacy" },
] as const;

export function AuthLegalLinks() {
  const { t } = useT("legal");
  return (
    <nav aria-label={t("authLinks.label")} className="pt-2">
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs">
        {LINKS.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="inline-flex min-h-10 items-center rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {t(`authLinks.${link.key}`)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
