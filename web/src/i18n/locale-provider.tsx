"use client";

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { I18nProvider } from "next-i18next/client";
import { resources } from "@/i18n/resources";
import { writeDeviceLocale } from "@/lib/device-locale-db";
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE_SECONDS,
  isLocale,
  type Locale,
} from "@/i18n/settings";

// 1-16G — Langue côté navigateur.
//
// Toutes les ressources FR/EN sont dans le bundle client (fichiers
// `/_next/static/*` hachés, déjà mis en cache par le service worker) : le
// changement de langue des composants client est IMMÉDIAT et fonctionne
// hors connexion. Il ne remonte aucun composant, ne recharge pas la page et
// ne touche ni aux formulaires, ni à la session, ni au socket, ni à l'outbox.
//
// Le rafraîchissement serveur (`router.refresh`, qui conserve l'état client)
// ne sert qu'aux textes rendus côté serveur (pages publiques, titres). Hors
// connexion, il est reporté au retour du réseau.

export const LOCALE_CHANGE_EVENT = "stockmaster:locale-change";

interface LocaleContextValue {
  locale: Locale;
  changeLocale: (next: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LOCALE,
  changeLocale: () => {},
});

// Repli en mémoire si les cookies sont refusés : le choix tient jusqu'au
// rechargement.
let memoryLocale: Locale | null = null;

export function readLocaleCookie(): Locale | null {
  try {
    const match = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${LOCALE_COOKIE}=`));
    const value = match?.slice(LOCALE_COOKIE.length + 1);
    return isLocale(value) ? value : memoryLocale;
  } catch {
    return memoryLocale;
  }
}

function writeLocaleCookie(locale: Locale): void {
  memoryLocale = locale;
  try {
    const secure = window.location.protocol === "https:" ? ";Secure" : "";
    document.cookie = `${LOCALE_COOKIE}=${locale};path=/;max-age=${LOCALE_COOKIE_MAX_AGE_SECONDS};SameSite=Lax${secure}`;
  } catch {
    // Cookies indisponibles : choix valable pour cette page seulement.
  }
}

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export function LocaleProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: React.ReactNode;
}) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const router = useRouter();
  const refreshPending = useRef(false);
  const localeRef = useRef(locale);

  const refreshServerText = useCallback(() => {
    if (!isOnline()) {
      refreshPending.current = true;
      return;
    }
    refreshPending.current = false;
    startTransition(() => router.refresh());
  }, [router]);

  const apply = useCallback((next: Locale) => {
    localeRef.current = next;
    setLocale(next);
    document.documentElement.lang = next;
  }, []);

  const changeLocale = useCallback(
    (next: Locale) => {
      if (!isLocale(next)) return;
      writeLocaleCookie(next);
      if (next === localeRef.current) return;
      apply(next);
      window.dispatchEvent(
        new CustomEvent(LOCALE_CHANGE_EVENT, { detail: next }),
      );
      refreshServerText();
    },
    [apply, refreshServerText],
  );

  // Langue lue par le service worker pour son message de repli.
  useEffect(() => {
    writeDeviceLocale(locale);
  }, [locale]);

  useEffect(() => {
    // Document servi par le cache du service worker (hors connexion) : il a
    // pu être rendu dans une autre langue que la préférence enregistrée.
    const saved = readLocaleCookie();
    if (saved && saved !== localeRef.current) apply(saved);

    const onOnline = () => {
      if (refreshPending.current) refreshServerText();
    };
    // Choix fait dans un autre onglet : appliqué au retour sur celui-ci.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const current = readLocaleCookie();
      if (current && current !== localeRef.current) {
        apply(current);
        refreshServerText();
      }
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [apply, refreshServerText]);

  const value = useMemo(
    () => ({ locale, changeLocale }),
    [locale, changeLocale],
  );

  return (
    <LocaleContext.Provider value={value}>
      <I18nProvider
        language={locale}
        resources={resources}
        supportedLngs={[...LOCALES]}
        fallbackLng={DEFAULT_LOCALE}
        i18nextOptions={{ initAsync: false, returnNull: false }}
      >
        {children}
      </I18nProvider>
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}
