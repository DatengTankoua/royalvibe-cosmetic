import type { Locale } from "@/i18n/settings";

// 1-16G — Langue de l'appareil pour le service worker (qui ne lit ni les
// cookies ni le stockage local) : une seule valeur `fr` ou `en`, aucune
// donnée personnelle. Lue par `public/sw.js` pour son unique message de
// repli (« Notifications désactivées sur cet appareil »). Toute erreur est
// silencieuse : le service worker retombe alors sur le français.
export const DEVICE_LOCALE_DB = "stockmaster-preferences";
const STORE = "preferences";
const KEY = "locale";

export function writeDeviceLocale(locale: Locale): void {
  try {
    if (typeof indexedDB === "undefined") return;
    const request = indexedDB.open(DEVICE_LOCALE_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(locale, KEY);
        tx.oncomplete = () => db.close();
        tx.onerror = () => db.close();
        tx.onabort = () => db.close();
      } catch {
        db.close();
      }
    };
  } catch {
    // stockage indisponible : le service worker utilisera le français
  }
}
