import { createInstance, type TFunction } from "i18next";
import { resources } from "@/i18n/resources";
import {
  DEFAULT_LOCALE,
  LOCALES,
  isLocale,
  type Locale,
} from "@/i18n/settings";

// 1-16G — Traduction pour le code hors composants (bibliothèques d'appel
// API, messages d'erreur génériques). Instance séparée, sans état global de
// langue : chaque appel lit la langue COURANTE du document (`<html lang>`,
// tenue à jour par `LocaleProvider`). Côté serveur, le français par défaut.
const instance = createInstance();
void instance.init({
  resources,
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: [...LOCALES],
  defaultNS: "common",
  initAsync: false,
  returnNull: false,
  interpolation: { escapeValue: false },
});

/** Langue de l'interface (navigateur) ; français hors navigateur. */
export function currentLocale(): Locale {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const lang = document.documentElement.lang;
  return isLocale(lang) ? lang : DEFAULT_LOCALE;
}

export function clientT(): TFunction<"common"> {
  return instance.getFixedT(currentLocale(), "common");
}
