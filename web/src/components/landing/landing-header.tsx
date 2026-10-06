"use client";

import { useEffect, useId, useRef, useState } from "react";
import { MenuIcon, XIcon } from "lucide-react";
import { Wordmark } from "@/components/brand/wordmark";
import { LANDING_NAV } from "@/components/landing/landing-nav";
import { SessionCta } from "@/components/landing/session-cta";

// 1-16B — En-tête de l'accueil public : ancres de la page, connexion et
// inscription (ou « Ouvrir l'application » pour une session déjà ouverte,
// via SessionCta, sans appel réseau). Sous 1024 px, la navigation passe dans
// un panneau ouvert par un bouton (aria-expanded), fermé par Échap, par un
// lien choisi ou au passage en largeur bureau.

const linkClass =
  "inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium text-(--brand-navy)/80 hover:text-(--brand-navy) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-navy)";

export function LandingHeader() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onResize = () => desktop.matches && setOpen(false);
    window.addEventListener("keydown", onKey);
    desktop.addEventListener("change", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      desktop.removeEventListener("change", onResize);
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-30 border-b border-(--brand-navy)/10 bg-white/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4">
        <a
          href="#haut"
          className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--brand-navy)"
          aria-label="Stock Master, haut de page"
        >
          <Wordmark size="small" priority />
        </a>

        <nav aria-label="Sections de la page" className="hidden lg:block">
          <ul className="flex items-center gap-3">
            {LANDING_NAV.map((item) => (
              <li key={item.href}>
                <a href={item.href} className={linkClass}>
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="hidden lg:block">
          <SessionCta variant="header" />
        </div>

        <button
          ref={buttonRef}
          type="button"
          className="inline-flex size-11 items-center justify-center rounded-lg text-(--brand-navy) hover:bg-(--brand-navy)/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-navy) lg:hidden"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={open ? "Fermer le menu" : "Ouvrir le menu"}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? (
            <XIcon className="size-6" aria-hidden />
          ) : (
            <MenuIcon className="size-6" aria-hidden />
          )}
        </button>
      </div>

      <div
        id={panelId}
        hidden={!open}
        className="border-t border-(--brand-navy)/10 bg-white px-4 pt-2 pb-5 lg:hidden"
      >
        <nav aria-label="Sections de la page (menu)">
          <ul className="flex flex-col">
            {LANDING_NAV.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className={`${linkClass} w-full text-base`}
                  onClick={() => setOpen(false)}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="mt-4">
          <SessionCta variant="menu" />
        </div>
      </div>
    </header>
  );
}
