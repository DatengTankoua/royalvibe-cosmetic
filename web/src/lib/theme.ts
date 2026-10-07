// 1-16F — Préférence de thème clair/sombre, par appareil.
//
// Stockage local fonctionnel dédié (une seule clé, trois valeurs possibles,
// aucune donnée métier ni identifiant). Toute indisponibilité du stockage
// (navigation privée, quota, accès refusé) est silencieuse : on retombe sur
// « Automatique », qui suit le thème du système.

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "stockmaster.theme";
export const THEME_PREFERENCES: readonly ThemePreference[] = [
  "light",
  "dark",
  "system",
];
export const DARK_QUERY = "(prefers-color-scheme: dark)";

export const THEME_LABELS: Record<ThemePreference, string> = {
  light: "Clair",
  dark: "Sombre",
  system: "Automatique",
};

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

// Repli en mémoire quand le stockage est indisponible : le choix tient
// jusqu'au rechargement, sans erreur.
let memoryPreference: ThemePreference = "system";

export function readThemePreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return memoryPreference;
  }
}

export function writeThemePreference(preference: ThemePreference): void {
  memoryPreference = preference;
  try {
    if (preference === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    // Stockage indisponible : le choix vaut pour la page en cours seulement.
  }
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

/**
 * Applique le thème sur <html> (classe `dark` + `color-scheme` pour les
 * contrôles natifs). Les transitions CSS sont suspendues le temps d'un
 * rendu pour éviter un fondu disparate entre composants.
 */
export function applyResolvedTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  const isDark = theme === "dark";
  if (
    root.classList.contains("dark") === isDark &&
    root.style.colorScheme === theme
  ) {
    return;
  }
  const pause = document.createElement("style");
  pause.appendChild(
    document.createTextNode("*,*::before,*::after{transition:none!important}"),
  );
  document.head.appendChild(pause);
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = theme;
  // Force le recalcul des styles avant de rétablir les transitions.
  void window.getComputedStyle(document.body).opacity;
  window.setTimeout(() => pause.remove(), 1);
}

/**
 * Script inline exécuté dans <head> avant le premier rendu : pose la classe
 * `dark` sans attendre l'hydratation (aucun flash du thème opposé). Chaîne
 * statique, sans valeur dynamique ; tolère l'absence de stockage.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var p=null;try{p=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})}catch(e){}var d=p==="dark"||(p!=="light"&&window.matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light"}catch(e){}})();`;
