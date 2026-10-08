import { clearAllOfflineCatalogData } from "./offline-catalog-db";
import { clearOfflineIdentity } from "./offline-identity-db";
import { clearSalesCapability } from "./offline-sales-capability";
import { clearTenantBrand } from "./offline-tenant-brand-db";

// Point d'entrée UNIQUE de purge hors ligne (logout, bouton manuel) :
// catalogue, identité, capacité de vente hors ligne (1-11C.3) et identité
// visuelle du commerce (1-12A), jamais bloquant côté appelant (chaque
// fonction sous-jacente a déjà son propre timeout défensif). L'outbox des
// ventes (`stockmaster-offline-sales-outbox`) n'est JAMAIS purgée ici.
export async function purgeAllOfflineData(): Promise<boolean> {
  const [catalogOk, identityOk, capabilityOk, brandOk] = await Promise.all([
    clearAllOfflineCatalogData(),
    clearOfflineIdentity(),
    clearSalesCapability(),
    clearTenantBrand(),
  ]);
  return catalogOk && identityOk && capabilityOk && brandOk;
}
