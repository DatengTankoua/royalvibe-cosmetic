// 1-16G — Réglages de langue partagés par le proxy, le serveur et le
// navigateur. Aucun import lourd ici (le proxy le charge à chaque requête) :
// les ressources de traduction sont ajoutées dans `i18n/config.ts`.

import type { I18nConfig } from "next-i18next/proxy";

export const LOCALES = ["fr", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** Langue sans préférence reconnue. */
export const DEFAULT_LOCALE: Locale = "fr";

/**
 * Cookie de préférence de langue : posé UNIQUEMENT par le sélecteur
 * « Français / English » (jamais par la détection du navigateur), lu par le
 * proxy pour rendre la page dans la bonne langue. Valeur `fr` ou `en`,
 * aucune donnée personnelle. Documenté dans la page Cookies.
 */
export const LOCALE_COOKIE = "stockmaster.lang";
/** Durée réelle du cookie : 365 jours. */
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** En-tête interne posé par le proxy (écrase toute valeur reçue). */
export const LOCALE_HEADER = "x-i18next-current-language";

export const NAMESPACES = [
  "common",
  "public",
  "auth",
  "catalog",
  "sales",
  "analytics",
  "organization",
  "subscription",
  "notifications",
  "legal",
] as const;
export type Namespace = (typeof NAMESPACES)[number];

export function isLocale(value: unknown): value is Locale {
  return value === "fr" || value === "en";
}

export function parseLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/**
 * Locale Intl d'affichage : dates et nombres suivent la langue choisie ;
 * la devise (FCFA), le fuseau et les bornes comptables ne changent pas.
 */
export function intlLocale(locale: Locale): string {
  return locale === "en" ? "en-GB" : "fr-FR";
}

/** Configuration de base next-i18next (sans ressources). */
export const baseI18nConfig: I18nConfig = {
  supportedLngs: [...LOCALES],
  fallbackLng: DEFAULT_LOCALE,
  defaultNS: "common",
  ns: [...NAMESPACES],
  // URL inchangées : la langue n'apparaît jamais dans le chemin.
  localeInPath: false,
  cookieName: LOCALE_COOKIE,
  cookieMaxAge: LOCALE_COOKIE_MAX_AGE_SECONDS,
  headerName: LOCALE_HEADER,
  // Le proxy ne pose jamais le cookie : seul un choix explicite le crée.
  persistCookie: false,
};
