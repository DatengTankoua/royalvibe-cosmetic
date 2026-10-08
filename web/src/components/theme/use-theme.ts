"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  DARK_QUERY,
  THEME_STORAGE_KEY,
  applyResolvedTheme,
  readThemePreference,
  resolveTheme,
  systemPrefersDark,
  writeThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";

// 1-16F — Le thème est appliqué impérativement sur <html> (script inline au
// chargement, puis ici lors d'un choix, d'un changement système ou d'un
// autre onglet) : jamais depuis un rendu React. Les composants lisent la
// préférence via useSyncExternalStore pour l'affichage seulement. Aucun
// remontage, rechargement ni effet sur session, socket ou synchronisation.

const LOCAL_CHANGE = "stockmaster.theme-change";

function subscribePreference(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(LOCAL_CHANGE, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(LOCAL_CHANGE, onChange);
  };
}

function subscribeSystem(onChange: () => void): () => void {
  let media: MediaQueryList;
  try {
    media = window.matchMedia(DARK_QUERY);
  } catch {
    return () => {};
  }
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

const serverPreference = (): ThemePreference => "system";
const serverPrefersDark = () => false;

export function useThemePreference(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
} {
  const preference = useSyncExternalStore(
    subscribePreference,
    readThemePreference,
    serverPreference,
  );
  const prefersDark = useSyncExternalStore(
    subscribeSystem,
    systemPrefersDark,
    serverPrefersDark,
  );
  const setPreference = useCallback((next: ThemePreference) => {
    writeThemePreference(next);
    applyResolvedTheme(resolveTheme(next, systemPrefersDark()));
    window.dispatchEvent(new Event(LOCAL_CHANGE));
  }, []);
  return {
    preference,
    resolved: resolveTheme(preference, prefersDark),
    setPreference,
  };
}

/**
 * Monté une fois dans le layout racine : suit le thème du système en mode
 * Automatique et les choix faits dans un autre onglet du même navigateur.
 */
export function ThemeSync() {
  useEffect(() => {
    const sync = () =>
      applyResolvedTheme(
        resolveTheme(readThemePreference(), systemPrefersDark()),
      );
    // Rattrape un changement survenu entre le script inline et l'hydratation.
    sync();
    const offSystem = subscribeSystem(sync);
    const offStorage = subscribePreference(sync);
    return () => {
      offSystem();
      offStorage();
    };
  }, []);
  return null;
}
