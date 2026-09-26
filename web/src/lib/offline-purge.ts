import { clearAllOfflineCatalogData } from "./offline-catalog-db";
import { clearOfflineIdentity } from "./offline-identity-db";

// Point d'entrée UNIQUE de purge hors ligne (logout, switch d'organisation
// réussi, bouton manuel) : toujours les deux bases, jamais bloquant côté
// appelant (chaque fonction sous-jacente a déjà son propre timeout défensif).
export async function purgeAllOfflineData(): Promise<boolean> {
  const [catalogOk, identityOk] = await Promise.all([
    clearAllOfflineCatalogData(),
    clearOfflineIdentity(),
  ]);
  return catalogOk && identityOk;
}
