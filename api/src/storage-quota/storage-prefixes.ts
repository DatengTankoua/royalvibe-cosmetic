/**
 * Préfixes EXACTS des fichiers d'une organisation (clés serveur, jamais
 * clientes). Définis ici, sans dépendance, pour être partagés par les
 * produits, le branding et la comptabilisation du stockage (1-17B) sans
 * import circulaire. Réexportés par `products.service` et
 * `organizations.service` (emplacements historiques).
 */
export function productImagePrefix(organizationId: string): string {
  return `organizations/${organizationId}/products`;
}

export function logoKeyPrefix(organizationId: string): string {
  return `organizations/${organizationId}/branding`;
}

/** Nature d'un fichier comptabilisé. */
export type StoredObjectKind = 'product_image' | 'logo';

export const STORED_OBJECT_KINDS: readonly StoredObjectKind[] = Object.freeze([
  'product_image',
  'logo',
]);

export function prefixForKind(
  kind: StoredObjectKind,
  organizationId: string,
): string {
  return kind === 'logo'
    ? logoKeyPrefix(organizationId)
    : productImagePrefix(organizationId);
}
