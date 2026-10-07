import { cookies, headers } from "next/headers";
import { createServerI18next } from "next-i18next/server";
import { i18nConfig } from "@/i18n/config";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_HEADER,
  isLocale,
  type Locale,
  type Namespace,
} from "@/i18n/settings";

// 1-16G — Traductions côté serveur. L'instance i18next est partagée par le
// processus, mais elle n'est JAMAIS mise dans une langue « courante » :
// chaque appel reçoit une fonction `t` figée sur la langue de SA requête
// (`getFixedT`). Deux requêtes simultanées FR/EN ne peuvent donc pas se
// mélanger. Lire la langue (en-têtes) rend la route dynamique.
const server = createServerI18next(i18nConfig);

/** Langue de la requête en cours, toujours validée (`fr` ou `en`). */
export async function getRequestLocale(): Promise<Locale> {
  const fromProxy = (await headers()).get(LOCALE_HEADER);
  if (isLocale(fromProxy)) return fromProxy;
  // Repli si le proxy n'a pas traité la requête.
  const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(fromCookie) ? fromCookie : DEFAULT_LOCALE;
}

export async function getServerT<N extends Namespace>(ns: N) {
  const lng = await getRequestLocale();
  const { t } = await server.getT(ns, { lng });
  return { t, lng };
}
