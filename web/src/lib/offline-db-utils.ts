// Utilitaires IndexedDB partagés (1-11B, robustesse purge) : uniquement de
// la mécanique générique, jamais de contenu applicatif ici.

// Ne bloque jamais un appelant (ex. logout) : résout avec `onTimeout()` si la
// promesse n'a pas terminé dans le délai imparti, sans jamais rejeter.
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(onTimeout());
      }
    }, ms);
    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(onTimeout());
        }
      },
    );
  });
}

// Une connexion bloquée par une suppression/upgrade ailleurs (autre onglet)
// se ferme d'elle-même plutôt que de bloquer indéfiniment cette opération.
export function attachVersionChangeAutoClose(db: IDBDatabase): void {
  db.onversionchange = () => db.close();
}

// onsuccess/onerror/onblocked terminent tous la promesse (jamais de blocage
// indéfini d'un logout/switch en attente de purge) ; timeout défensif court.
export function deleteIndexedDb(
  name: string,
  timeoutMs = 2000,
): Promise<boolean> {
  const attempt = new Promise<boolean>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(true);
    } catch {
      resolve(false);
    }
  });
  return withTimeout(attempt, timeoutMs, () => false);
}
