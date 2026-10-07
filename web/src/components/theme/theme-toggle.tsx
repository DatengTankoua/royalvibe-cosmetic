"use client";

import { Menu } from "@base-ui/react/menu";
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useThemePreference } from "@/components/theme/use-theme";
import {
  THEME_LABELS,
  THEME_PREFERENCES,
  parseThemePreference,
  type ThemePreference,
} from "@/lib/theme";

const ICONS: Record<ThemePreference, typeof SunIcon> = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
};

// 1-16F — Contrôle commun du thème (en-têtes publics, auth, /access, écran
// de blocage et shell /app). Menu Base UI : rôle `menuitemradio` + état
// coché, flèches/Entrée/Échap au clavier, focus rendu au bouton. L'icône
// soleil/lune suit le thème affiché via CSS (`dark:`), donc identique au
// rendu serveur : aucune différence d'hydratation.
export function ThemeToggle({ className }: { className?: string }) {
  const { preference, setPreference } = useThemePreference();
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label={`Thème d'affichage : ${THEME_LABELS[preference]}`}
        title="Thème d'affichage"
        data-testid="theme-toggle"
        className={
          className ??
          "inline-flex rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        }
      >
        <SunIcon className="h-4 w-4 dark:hidden" aria-hidden="true" />
        <MoonIcon className="hidden h-4 w-4 dark:block" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-50">
          <Menu.Popup
            data-testid="theme-menu"
            className="min-w-44 rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
          >
            <Menu.Group>
              <Menu.GroupLabel className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                Thème d&apos;affichage
              </Menu.GroupLabel>
              <Menu.RadioGroup
                value={preference}
                onValueChange={(value) =>
                  setPreference(parseThemePreference(value))
                }
              >
                {THEME_PREFERENCES.map((option) => {
                  const Icon = ICONS[option];
                  return (
                    <Menu.RadioItem
                      key={option}
                      value={option}
                      closeOnClick
                      className="flex min-h-10 cursor-default items-center gap-2 rounded-md px-2 outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-checked:font-medium"
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="flex-1">{THEME_LABELS[option]}</span>
                      <Menu.RadioItemIndicator className="inline-flex">
                        <CheckIcon className="h-4 w-4" aria-hidden="true" />
                      </Menu.RadioItemIndicator>
                    </Menu.RadioItem>
                  );
                })}
              </Menu.RadioGroup>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
