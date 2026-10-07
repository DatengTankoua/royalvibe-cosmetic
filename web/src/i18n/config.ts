import type { I18nConfig } from "next-i18next/proxy";
import { resources } from "@/i18n/resources";
import { baseI18nConfig } from "@/i18n/settings";

// 1-16G — Configuration next-i18next complète. Les ressources sont des
// modules importés statiquement : elles font partie du build (serveur
// Vercel/Docker et bundle client), sans lecture de fichier à l'exécution ni
// service distant.
export const i18nConfig: I18nConfig = {
  ...baseI18nConfig,
  resources,
  i18nextOptions: {
    initAsync: false,
    returnNull: false,
    interpolation: { escapeValue: false },
  },
};
