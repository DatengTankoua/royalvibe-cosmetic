/**
 * 1-14D.2G — CLI OPÉRATEUR de rapprochement des paiements d'abonnement.
 *
 * Usage (après `pnpm --filter api build`, avec l'environnement de l'API :
 * MONGODB_URI, JWT_SECRET, et CORS_ORIGIN si NODE_ENV=production) :
 *   pnpm --filter api subscription:reconcile-payment -- inspect --payment-id=<id>
 *   pnpm --filter api subscription:reconcile-payment -- reconcile --payment-id=<id> [--reference=<uuid>]
 *   pnpm --filter api subscription:reconcile-payment -- reconcile --payment-id=<id> [--reference=<uuid>] \
 *     --apply --plan=<jeton> --operation-id=<uuid v4> --operator=<id> --reason=<motif> [--ticket=<réf>]
 *
 * - Contexte applicatif Nest (`AppModule`) : le fournisseur est celui
 *   INJECTÉ par l'application (`PAYMENT_PROVIDER`) ; aucun drapeau ne le
 *   remplace. En production, `UnavailablePaymentProvider` : aucune
 *   consultation ni mutation possible.
 * - Aucun serveur HTTP démarré ; aucune route ajoutée.
 * - Arguments validés AVANT tout chargement de l'application (code 2).
 * - `MONGODB_URI` doit être fourni EXPLICITEMENT par l'environnement : il est
 *   vérifié AVANT le chargement d'`AppModule`, dont le `ConfigModule` lit un
 *   éventuel `.env` du répertoire courant (sans écraser une variable déjà
 *   définie). Un `.env` local ne peut donc pas désigner implicitement la
 *   base cible ; il peut fournir les autres variables, comme pour l'API.
 * - AUCUNE écriture implicite au démarrage : `autoIndex` et `autoCreate` sont
 *   désactivés sur l'instance Mongoose (partagée avec `@nestjs/mongoose`)
 *   AVANT le chargement de l'application, quel que soit `NODE_ENV`. Les
 *   collections et index restent créés par les migrations explicites ; le
 *   comportement de l'API (autre processus) est inchangé.
 * - Le processus se termine explicitement une fois la sortie écrite (le
 *   contexte Nest peut conserver des ressources ouvertes).
 * - Ne journalise jamais l'URI, un secret, un téléphone ni une réponse brute.
 */
import { NestFactory } from '@nestjs/core';
import mongoose from 'mongoose';
import {
  RECONCILIATION_EXIT,
  RECONCILIATION_USAGE,
  parseReconciliationArguments,
  runReconciliationCommand,
} from '../subscriptions/payments/reconciliation/payment-reconciliation-cli';

/**
 * Désactive les créations automatiques de collections (`autoCreate`) et
 * d'index (`autoIndex`) pour TOUS les modèles qui seront compilés ensuite
 * (options de base de Mongoose : aucun schéma ni la connexion de
 * l'application ne les redéfinissent).
 */
export function disableImplicitSchemaWrites(): void {
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
}

async function main(): Promise<number> {
  const command = parseReconciliationArguments(process.argv.slice(2));
  if ('error' in command) {
    console.error(
      `Arguments invalides : ${command.error}.\n${RECONCILIATION_USAGE}`,
    );
    return RECONCILIATION_EXIT.USAGE;
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI requis.');
    return RECONCILIATION_EXIT.ERROR;
  }
  // Avant tout modèle : aucune collection ni index créés implicitement.
  disableImplicitSchemaWrites();
  // Chargement DIFFÉRÉ : rien de l'application (ni `.env`) avant ce point.
  const { AppModule } = await import('../app.module.js');
  const { PaymentReconciliationService } =
    await import('../subscriptions/payments/reconciliation/payment-reconciliation.service.js');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  try {
    return await runReconciliationCommand(
      command,
      app.get(PaymentReconciliationService),
      {
        out: (value) => console.log(JSON.stringify(value, null, 2)),
        err: (message) => console.error(message),
      },
    );
  } finally {
    await app.close();
  }
}

/** Sortie explicite APRÈS vidage des flux (aucune ligne perdue). */
function exit(code: number): void {
  process.stdout.write('', () => {
    process.stderr.write('', () => process.exit(code));
  });
}

if (require.main === module) {
  main().then(exit, (error: unknown) => {
    console.error(
      `Rapprochement interrompu (${error instanceof Error ? error.name : 'erreur'}).`,
    );
    exit(RECONCILIATION_EXIT.ERROR);
  });
}
