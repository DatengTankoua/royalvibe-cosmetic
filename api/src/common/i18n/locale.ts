/**
 * 1-16G — Langues de l'application (français, anglais).
 *
 * Deux sources, jamais mélangées :
 * - la langue d'une REQUÊTE (paramètre `lang`, sinon en-tête
 *   `Accept-Language` envoyé par le navigateur) : messages d'erreur et
 *   contenus lus par l'appelant lui-même (centre de notifications, exports) ;
 * - la langue d'un DESTINATAIRE (`User.locale`) : e-mails et notifications
 *   push, qui ne dépendent jamais de la requête ni de l'utilisateur qui a
 *   déclenché l'envoi.
 * Sans préférence reconnue : français. Aucune langue globale du processus.
 */
export const APP_LOCALES = ['fr', 'en'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];
export const DEFAULT_APP_LOCALE: AppLocale = 'fr';

export function isAppLocale(value: unknown): value is AppLocale {
  return value === 'fr' || value === 'en';
}

/** Préférence enregistrée d'un destinataire ; compte ancien → français. */
export function recipientLocale(value: unknown): AppLocale {
  return isAppLocale(value) ? value : DEFAULT_APP_LOCALE;
}

/** Première langue prise en charge d'un en-tête `Accept-Language`. */
export function localeFromAcceptLanguage(
  header: string | string[] | undefined,
): AppLocale {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw || raw.length > 512) return DEFAULT_APP_LOCALE;
  const ranked = raw
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return {
        base: tag.trim().toLowerCase().split('-')[0],
        weight: Number.isFinite(weight) ? weight : 0,
        index,
      };
    })
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const entry of ranked) {
    if (isAppLocale(entry.base)) return entry.base;
  }
  return DEFAULT_APP_LOCALE;
}

interface LocaleRequestLike {
  query?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Langue DEMANDÉE explicitement par une requête (`?lang=` ou en-tête
 * `Accept-Language`), sinon `null` : un appel sans indication de langue
 * (outil, script) reçoit les messages tels qu'ils sont écrits.
 */
export function requestedLocale(request: LocaleRequestLike): AppLocale | null {
  const query = request.query as Record<string, unknown> | undefined;
  if (isAppLocale(query?.lang)) return query.lang;
  const header = request.headers?.['accept-language'];
  if (!header || (Array.isArray(header) && header.length === 0)) return null;
  return localeFromAcceptLanguage(header);
}

/** Langue d'une requête : `?lang=` explicite, sinon `Accept-Language`. */
export function localeFromRequest(request: LocaleRequestLike): AppLocale {
  const query = request.query as Record<string, unknown> | undefined;
  const explicit = query?.lang;
  if (isAppLocale(explicit)) return explicit;
  return localeFromAcceptLanguage(request.headers?.['accept-language']);
}
