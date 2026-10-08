/**
 * 1-14D.2H — Rapprochement SIMULÉ (entrée de TEST, distincte du vrai CLI).
 *
 * Réutilise tels quels le parseur (`parseReconciliationArguments`), la
 * couche de commande (`runReconciliationCommand`, codes de sortie) et le
 * service (`PaymentReconciliationService`) compilés de D.2G. Seul le
 * fournisseur diffère : VRAI adaptateur CamPay sur le faux CamPay local du
 * lanceur (127.0.0.1), injecté ICI par `overrideProvider`.
 *
 * Le VRAI CLI (`dist/migrations/reconcile-subscription-payment.js`, script
 * `subscription:reconcile-payment`) n'a aucune surcharge : avec
 * `UnavailablePaymentProvider`, sa simulation et son application restent
 * bloquées (`provider-unavailable`, code 4). `recipe.js real-cli` le montre.
 */
'use strict';

require('./preload.cjs');
const C = require('./recipe-common');

async function main() {
  const cli = C.dist(
    'subscriptions/payments/reconciliation/payment-reconciliation-cli',
  );
  const command = cli.parseReconciliationArguments(process.argv.slice(2));
  if ('error' in command) {
    console.error(
      `Arguments invalides : ${command.error}.\n${cli.RECONCILIATION_USAGE}`,
    );
    return cli.RECONCILIATION_EXIT.USAGE;
  }
  C.assertRecipeUri(process.env.MONGODB_URI);
  const { disableImplicitSchemaWrites } = C.dist(
    'migrations/reconcile-subscription-payment',
  );
  disableImplicitSchemaWrites();
  const {
    campayProvider,
    assertImplicitWritesDisabled,
  } = require('./boot-api');
  assertImplicitWritesDisabled();
  console.error(
    '[RECETTE LOCALE] Rapprochement SIMULÉ : faux CamPay 127.0.0.1, base éphémère. ' +
      'Ce n’est PAS le CLI de production (dont le fournisseur reste indisponible).',
  );

  const { Test } = C.apiRequire('@nestjs/testing');
  const { AppModule } = C.dist('app.module');
  const { PAYMENT_PROVIDER } = C.dist(
    'subscriptions/payments/payment-provider',
  );
  const { PaymentReconciliationService } = C.dist(
    'subscriptions/payments/reconciliation/payment-reconciliation.service',
  );
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PAYMENT_PROVIDER)
    .useValue(campayProvider())
    .compile();
  moduleRef.useLogger(false);
  await moduleRef.init();
  try {
    return await cli.runReconciliationCommand(
      command,
      moduleRef.get(PaymentReconciliationService),
      {
        out: (value) => console.log(JSON.stringify(value, null, 2)),
        err: (message) => console.error(message),
      },
    );
  } finally {
    await moduleRef.close();
  }
}

function exit(code) {
  process.stdout.write('', () => {
    process.stderr.write('', () => process.exit(code));
  });
}

if (require.main === module) {
  main().then(exit, (error) => {
    console.error(
      `Rapprochement simulé interrompu (${error instanceof Error ? error.message : 'erreur'}).`,
    );
    exit(1);
  });
}
