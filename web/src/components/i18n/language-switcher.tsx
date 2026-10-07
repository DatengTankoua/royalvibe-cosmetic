"use client";

import { Menu } from "@base-ui/react/menu";
import { CheckIcon, LanguagesIcon } from "lucide-react";
import { useT } from "next-i18next/client";
import { useLocale } from "@/i18n/locale-provider";
import { LOCALES, isLocale, type Locale } from "@/i18n/settings";

// Nom de chaque langue écrit dans cette langue (jamais traduit).
const NATIVE_NAMES: Record<Locale, string> = {
  fr: "Français",
  en: "English",
};

// 1-16G — Contrôle commun « Français / English » (en-têtes publics,
// authentification, accès limité, écran de blocage et shell /app). Même
// menu Base UI que le thème : `menuitemradio`, clavier, focus rendu au
// bouton. Changer de langue ne recharge pas la page.
export function LanguageSwitcher({ className }: { className?: string }) {
  const { t } = useT("common");
  const { locale, changeLocale } = useLocale();
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label={t("language.trigger", { language: NATIVE_NAMES[locale] })}
        title={t("language.title")}
        data-testid="language-switcher"
        className={
          className ??
          "inline-flex items-center gap-1 rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        }
      >
        <LanguagesIcon className="h-4 w-4" aria-hidden="true" />
        <span className="text-xs font-semibold uppercase" aria-hidden="true">
          {locale}
        </span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-50">
          <Menu.Popup
            data-testid="language-menu"
            className="min-w-40 rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
          >
            <Menu.Group>
              <Menu.GroupLabel className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                {t("language.title")}
              </Menu.GroupLabel>
              <Menu.RadioGroup
                value={locale}
                onValueChange={(value) => {
                  if (isLocale(value)) changeLocale(value);
                }}
              >
                {LOCALES.map((option) => (
                  <Menu.RadioItem
                    key={option}
                    value={option}
                    closeOnClick
                    lang={option}
                    className="flex min-h-10 cursor-default items-center gap-2 rounded-md px-2 outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-checked:font-medium"
                  >
                    <span className="w-6 text-xs font-semibold uppercase text-muted-foreground">
                      {option}
                    </span>
                    <span className="flex-1">{NATIVE_NAMES[option]}</span>
                    <Menu.RadioItemIndicator className="inline-flex">
                      <CheckIcon className="h-4 w-4" aria-hidden="true" />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
