"use client";

import { useEffect, useId, useRef, useState } from "react";
import { MenuIcon, XIcon } from "lucide-react";
import { useT } from "next-i18next/client";
import { Wordmark } from "@/components/brand/wordmark";
import { LANDING_NAV } from "@/components/landing/landing-nav";
import { SessionCta } from "@/components/landing/session-cta";
import {
  PUBLIC_LANGUAGE_SWITCHER_CLASS,
  PUBLIC_THEME_TOGGLE_CLASS,
} from "@/components/public/header-classes";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";

// 1-16B — En-tête de l'accueil public : ancres de la page, connexion et
// inscription (ou « Ouvrir l'application » pour une session déjà ouverte,
// via SessionCta, sans appel réseau). Sous 1024 px, la navigation passe dans
// un panneau ouvert par un bouton (aria-expanded), fermé par Échap, par un
// lien choisi ou au passage en largeur bureau.

const linkClass =
  "inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium text-(--brand-ink)/80 hover:text-(--brand-ink) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-ink)";

export function LandingHeader() {
  const { t } = useT("public");
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
    <header className="sticky top-0 z-30 border-b border-(--brand-ink)/10 bg-(--public-bg)/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4">
        <a
          href="#haut"
          className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--brand-ink)"
          aria-label={t("header.homeTop")}
        >
          <Wordmark size="small" priority />
        </a>

        <nav aria-label={t("header.sections")} className="hidden lg:block">
          <ul className="flex items-center gap-3">
            {LANDING_NAV.map((item) => (
              <li key={item.href}>
                <a href={item.href} className={linkClass}>
                  {t(`nav.${item.key}`)}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* 1-16F : thème toujours visible ; sous 1024 px, à côté du bouton
            de menu (le panneau de navigation reste inchangé). 1-16G : langue
            juste avant le thème. */}
        <div className="flex items-center gap-1 lg:gap-3">
          <LanguageSwitcher className={PUBLIC_LANGUAGE_SWITCHER_CLASS} />
          <ThemeToggle className={PUBLIC_THEME_TOGGLE_CLASS} />
          <div className="hidden lg:block">
            <SessionCta variant="header" />
          </div>

          <button
            ref={buttonRef}
            type="button"
            className="inline-flex size-11 items-center justify-center rounded-lg text-(--brand-ink) hover:bg-(--brand-ink)/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-ink) lg:hidden"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={open ? t("header.closeMenu") : t("header.openMenu")}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? (
              <XIcon className="size-6" aria-hidden />
            ) : (
              <MenuIcon className="size-6" aria-hidden />
            )}
          </button>
        </div>
      </div>

      <div
        id={panelId}
        hidden={!open}
        className="border-t border-(--brand-ink)/10 bg-(--public-bg) px-4 pt-2 pb-5 lg:hidden"
      >
        <nav aria-label={t("header.sectionsMenu")}>
          <ul className="flex flex-col">
            {LANDING_NAV.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className={`${linkClass} w-full text-base`}
                  onClick={() => setOpen(false)}
                >
                  {t(`nav.${item.key}`)}
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
