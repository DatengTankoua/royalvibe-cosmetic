import { clearAllOfflineCatalogData } from "./offline-catalog-db";
import { clearOfflineIdentity } from "./offline-identity-db";
import { clearSalesCapability } from "./offline-sales-capability";

// Point d'entrée UNIQUE de purge hors ligne (logout, switch d'organisation
// réussi, bouton manuel) : catalogue, identité et capacité de vente hors
// ligne (1-11C.3), jamais bloquant côté appelant (chaque fonction
// sous-jacente a déjà son propre timeout défensif). L'outbox des ventes
// (`stockmaster-offline-sales-outbox`) n'est JAMAIS purgée ici.
export async function purgeAllOfflineData(): Promise<boolean> {
  const [catalogOk, identityOk, capabilityOk] = await Promise.all([
    clearAllOfflineCatalogData(),
    clearOfflineIdentity(),
    clearSalesCapability(),
  ]);
  return catalogOk && identityOk && capabilityOk;
}
