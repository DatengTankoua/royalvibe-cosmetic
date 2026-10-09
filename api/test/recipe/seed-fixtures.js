/**
 * 1-14D.2H — Peuplement EXPLICITE de la base éphémère (TEST), lancé par le
 * lanceur APRÈS les migrations et AVANT l'API.
 *
 * 1. `autoIndex` / `autoCreate` neutralisés avant le contexte Nest.
 * 2. Schéma des fixtures : création explicite des collections absentes et,
 *    pour les seuls schémas dont la production confie les index à
 *    `autoIndex` (utilisateurs, organisations, adhésions, invitations,
 *    produits, ventes, rayons, audit), de leurs index déclarés. Les
 *    collections de paiement, périodes, opérations de vente et audits de
 *    rapprochement (`autoIndex: false`) relèvent des migrations.
 * 3. Comptes fictifs via les SERVICES RÉELS de l'API (inscription, lien de
 *    vérification, invitation, acceptation), puis expiration explicite.
 *
 * Sortie : une ligne `FIXTURES <json>` (identifiants, aucun secret).
 */
'use strict';

require('./preload.cjs');
const C = require('./recipe-common');
const { ACCOUNTS } = require('./fixtures');
const { expireOrganization } = require('./db-tools');
const { legalAcceptance } = require('./actions');

async function main() {
  C.assertRecipeUri(process.env.MONGODB_URI);
  if (process.env.RECIPE_LAUNCHED !== '1')
    throw new Error('À lancer par recipe.js start.');
  const { disableImplicitSchemaWrites } = C.dist(
    'migrations/reconcile-subscription-payment',
  );
  disableImplicitSchemaWrites();
  require('./boot-api').assertImplicitWritesDisabled();

  const { Test } = C.apiRequire('@nestjs/testing');
  const { getConnectionToken } = C.apiRequire('@nestjs/mongoose');
  const { AppModule } = C.dist('app.module');
  const { EMAIL_SENDER } = C.dist('email-verification/email-sender');
  const { AuthService } = C.dist('auth/auth.service');
  const { OrganizationsService } = C.dist(
    'organizations/organizations.service',
  );
  const { EmailVerificationService } = C.dist(
    'email-verification/email-verification.service',
  );
  const { InvitationAcceptanceService } = C.dist(
    'organizations/invitation-acceptance.service',
  );

  const outbox = [];
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EMAIL_SENDER)
    .useValue({
      isConfigured: () => true,
      send: async (email) => void outbox.push(email),
    })
    .compile();
  await moduleRef.init();
  try {
    const connection = moduleRef.get(getConnectionToken());
    const schema = await createFixtureSchema(connection);

    const auth = moduleRef.get(AuthService);
    const invitations = moduleRef.get(InvitationAcceptanceService);
    const organizations = moduleRef.get(OrganizationsService);
    const verification = moduleRef.get(EmailVerificationService);
    const confirm = async (email) => {
      const mail = outbox.filter((m) => m.to === email).pop();
      const match =
        mail && /\/auth\/verify-email\?token=([^\s"&]+)/.exec(mail.text);
      if (!match) throw new Error(`Lien de vérification absent : ${email}`);
      await verification.confirm(decodeURIComponent(match[1]));
    };

    const created = {};
    for (const account of ACCOUNTS.filter((a) => a.role === 'owner')) {
      const result = await auth.register({
        name: account.name,
        email: account.email,
        password: C.PASSWORD,
        organizationName: account.organization,
        // 1-16C.2 : case cochée, comme le formulaire web.
        legalAcceptance: legalAcceptance('owner_registration'),
      });
      // 1-18E : résultat interne (identifiants) ; lien envoyé après la réponse.
      if (!result.created)
        throw new Error(`Adresse déjà utilisée : ${account.email}`);
      await auth.settleVerificationDispatches();
      await confirm(account.email);
      created[account.key] = {
        userId: result.userId,
        organizationId: result.organizationId,
      };
    }
    for (const account of ACCOUNTS.filter((a) => a.invitedBy)) {
      const owner = created[account.invitedBy];
      const { invitationUrl } = await organizations.createInvitation(
        owner.organizationId,
        owner.userId,
        {
          email: account.email,
          role: account.role,
        },
      );
      const token = new URL(invitationUrl).searchParams.get('token');
      // 1-18B : lien de création envoyé à l'adresse invitée (compte vérifié).
      const { delivery } = await invitations.requestAccountLink(token, 'fr');
      await delivery;
      const mail = outbox.filter((m) => m.to === account.email).pop();
      const match =
        mail &&
        /\/auth\/invitations\/create-account\?token=([^\s"&]+)/.exec(mail.text);
      if (!match) throw new Error(`Lien de création absent : ${account.email}`);
      await invitations.createAccount({
        token: decodeURIComponent(match[1]),
        name: account.name,
        password: C.PASSWORD,
        legalAcceptance: legalAcceptance('invitation_account'),
      });
      const user = await connection
        .collection('users')
        .findOne({ email: account.email });
      created[account.key] = {
        userId: String(user._id),
        organizationId: owner.organizationId,
      };
    }
    const db = connection.db;
    for (const account of ACCOUNTS.filter((a) => a.expired)) {
      await expireOrganization(db, created[account.key].organizationId);
    }
    process.stdout.write(
      `FIXTURES ${JSON.stringify({ schema, accounts: created })}\n`,
    );
  } finally {
    await moduleRef.close();
  }
}

/** Collections absentes créées ; index déclarés des schémas `autoIndex` de production. */
async function createFixtureSchema(connection) {
  const existing = new Set(
    (await connection.db.listCollections().toArray()).map((c) => c.name),
  );
  const collections = [];
  const indexed = [];
  for (const model of Object.values(connection.models)) {
    const name = model.collection.collectionName;
    if (!existing.has(name)) {
      await model.createCollection();
      existing.add(name);
      collections.push(name);
    }
    if (
      model.schema.get('autoIndex') !== false &&
      model.schema.indexes().length > 0
    ) {
      await model.createIndexes();
      indexed.push(name);
    }
  }
  return {
    createdCollections: collections.sort(),
    indexedByFixtures: indexed.sort(),
  };
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(`Fixtures interrompues : ${error && error.message}`);
      process.exit(1);
    },
  );
}
