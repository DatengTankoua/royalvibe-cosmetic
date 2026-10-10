/**
 * 1-20F — Migration idempotente : index de la liste paginée des produits
 * (`products`) `{organizationId, sectionId, deletedAt, createdAt -1, _id -1}`.
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:product-page-indexes
 *
 * - Rejouable sans effet : no-op si l'index exact existe déjà.
 * - Échoue (code 1) si un index homonyme a d'autres options — rien n'est
 *   écrasé ni supprimé.
 * - Sans cet index, la liste paginée reste CORRECTE (tri en mémoire du
 *   rayon, plus lent) : aucune vérification bloquante au démarrage.
 * - Contrôle en lecture seule de l'invariant du curseur (produits sans
 *   `createdAt`, attendu : 0) : avertissement seulement, aucune écriture.
 * - Ne journalise JAMAIS l'URI ni aucune donnée métier.
 */
import { createConnection } from 'mongoose';
import {
  countProductsWithoutCreatedAt,
  ensureProductPageIndexes,
} from '../products/product-page';

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const connection = await createConnection(uri).asPromise();
  try {
    const created = await ensureProductPageIndexes(connection);
    console.log(
      created.length > 0
        ? `products : index de la liste paginée créé (${created.join(', ')}).`
        : 'products : index de la liste paginée déjà présent (aucune modification).',
    );
    const undated = await countProductsWithoutCreatedAt(connection);
    if (undated > 0) {
      console.warn(
        `products : ${undated} produit(s) sans createdAt, absents de la liste paginée au-delà de la première page (à corriger avant le web 1-20F).`,
      );
    }
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Migration des index de la liste des produits échouée :',
      error instanceof Error ? error.message : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
