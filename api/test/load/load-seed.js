/**
 * 1-20A — Peuplement DÉTERMINISTE de la base éphémère de charge (TEST).
 *
 * Lancé par `load-stack.js` APRÈS les migrations de pré-déploiement et AVANT
 * l'API. Volumes : `PROFILES[LOAD_PROFILE]` (hypothèses de test).
 *
 * 1. Index déclarés des schémas confiés à `autoIndex` en production,
 *    garantis explicitement (même liste qu'en production : la recette
 *    `seed-fixtures.js` suit la même règle).
 * 2. Comptes par les SERVICES RÉELS : inscription du propriétaire (période
 *    d'essai, preuve légale), vérification d'e-mail, invitations puis
 *    création de compte des administrateurs et vendeurs.
 * 3. Catalogue, historique de ventes et notifications insérés en masse par
 *    les modèles réels (validation Mongoose), avec un stock COHÉRENT :
 *    `initialQuantity = remainingQuantity + Σ ventes`.
 * 4. Sessions préparées AVANT toute mesure : `AuthService.login` (vrais
 *    contrôles d'identifiants), une session par utilisateur.
 *
 * Sortie : `sessions.json` (jetons fictifs, base éphémère) et une ligne
 * `SEED <json>` (volumes, durées ; aucun secret).
 */
'use strict';

require('../recipe/preload.cjs');
const fs = require('fs');
const L = require('./load-common');
const { legalAcceptance } = require('../recipe/actions');

const { R } = L;
const DAY = 24 * 60 * 60 * 1000;

/** PRNG déterministe (mulberry32). */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  L.assertLoadUri(process.env.MONGODB_URI);
  if (process.env.LOAD_LAUNCHED !== '1')
    throw new Error('À lancer par load-stack.js start.');
  const profileName = process.env.LOAD_PROFILE;
  const profile = L.PROFILES[profileName];
  if (!profile) throw new Error(`Profil inconnu : ${profileName}`);

  const { Test } = R.apiRequire('@nestjs/testing');
  const { getConnectionToken, getModelToken } =
    R.apiRequire('@nestjs/mongoose');
  const { Types } = R.apiRequire('mongoose');
  const { AppModule } = L.dist('app.module');
  const { EMAIL_SENDER } = L.dist('email-verification/email-sender');
  const { AuthService } = L.dist('auth/auth.service');
  const { OrganizationsService } = L.dist(
    'organizations/organizations.service',
  );
  const { EmailVerificationService } = L.dist(
    'email-verification/email-verification.service',
  );
  const { InvitationAcceptanceService } = L.dist(
    'organizations/invitation-acceptance.service',
  );
  const { storageIdentity } = L.dist('s3/s3.service');
  const { productImagePrefix } = L.dist('storage-quota/storage-prefixes');

  const outbox = [];
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EMAIL_SENDER)
    .useValue({
      isConfigured: () => true,
      send: async (email) => void outbox.push(email),
    })
    .compile();
  await moduleRef.init();
  const t0 = Date.now();
  try {
    const connection = moduleRef.get(getConnectionToken());
    const indexed = await ensureSchemaIndexes(connection);

    const auth = moduleRef.get(AuthService);
    const organizations = moduleRef.get(OrganizationsService);
    const verification = moduleRef.get(EmailVerificationService);
    const invitations = moduleRef.get(InvitationAcceptanceService);
    const model = (name) => moduleRef.get(getModelToken(name));
    const Section = model('Section');
    const Product = model('Product');
    const Sale = model('Sale');
    const Notification = model('AppNotification');

    const confirmEmail = async (email) => {
      const mail = outbox.filter((m) => m.to === email).pop();
      const match =
        mail && /\/auth\/verify-email\?token=([^\s"&]+)/.exec(mail.text);
      if (!match) throw new Error(`Lien de vérification absent : ${email}`);
      await verification.confirm(decodeURIComponent(match[1]));
    };

    const plan = [];
    for (let i = 0; i < profile.standard.count; i += 1)
      plan.push({ key: `std${i + 1}`, kind: 'standard', ...profile.standard });
    for (let i = 0; i < profile.concentrated.count; i += 1)
      plan.push({
        key: `conc${i + 1}`,
        kind: 'concentrated',
        ...profile.concentrated,
      });

    const storage = storageIdentity(L.STORAGE_URL, L.STORAGE_BUCKET);
    const users = [];
    const orgs = [];
    const now = Date.now();
    let totals = { sections: 0, products: 0, sales: 0, notifications: 0 };

    for (const [orgIndex, spec] of plan.entries()) {
      const random = prng(1000 + orgIndex);
      // ── Comptes (services réels) ──────────────────────────────────────
      const ownerEmail = `owner.${spec.key}@charge.local`;
      const registered = await auth.register({
        name: `Proprio ${spec.key}`,
        email: ownerEmail,
        password: L.PASSWORD,
        organizationName: `Charge ${spec.key}`,
        legalAcceptance: legalAcceptance('owner_registration'),
      });
      if (!registered.created) throw new Error(`Déjà utilisé : ${ownerEmail}`);
      await auth.settleVerificationDispatches();
      await confirmEmail(ownerEmail);
      const organizationId = registered.organizationId;
      const members = [
        { email: ownerEmail, role: 'owner', userId: registered.userId },
      ];
      const invitees = [
        ...Array.from({ length: spec.admins }, (_, i) => ({
          email: `admin${i + 1}.${spec.key}@charge.local`,
          role: 'admin',
          name: `Admin${i + 1} ${spec.key}`,
        })),
        ...Array.from({ length: spec.sellers }, (_, i) => ({
          email: `seller${i + 1}.${spec.key}@charge.local`,
          role: 'seller',
          name: `Vendeur${i + 1} ${spec.key}`,
        })),
      ];
      for (const invitee of invitees) {
        const { invitationUrl } = await organizations.createInvitation(
          organizationId,
          registered.userId,
          { email: invitee.email, role: invitee.role },
        );
        const token = new URL(invitationUrl).searchParams.get('token');
        const { delivery } = await invitations.requestAccountLink(token, 'fr');
        await delivery;
        const mail = outbox.filter((m) => m.to === invitee.email).pop();
        const match =
          mail &&
          /\/auth\/invitations\/create-account\?token=([^\s"&]+)/.exec(
            mail.text,
          );
        if (!match) throw new Error(`Lien absent : ${invitee.email}`);
        await invitations.createAccount({
          token: decodeURIComponent(match[1]),
          name: invitee.name,
          password: L.PASSWORD,
          legalAcceptance: legalAcceptance('invitation_account'),
        });
        const user = await connection
          .collection('users')
          .findOne({ email: invitee.email });
        members.push({
          email: invitee.email,
          role: invitee.role,
          userId: String(user._id),
        });
      }

      // ── Catalogue ─────────────────────────────────────────────────────
      const orgOid = new Types.ObjectId(organizationId);
      const sectionDocs = Array.from({ length: spec.sections }, (_, i) =>
        doc(Section, {
          organizationId: orgOid,
          name: `Rayon ${String(i + 1).padStart(2, '0')}`,
        }),
      );
      await Section.collection.insertMany(sectionDocs);
      const prefix = productImagePrefix(organizationId);
      const products = Array.from({ length: spec.products }, (_, i) => {
        const salePrice = 500 + Math.floor(random() * 50) * 100;
        return {
          _id: new Types.ObjectId(),
          organizationId: orgOid,
          sectionId: sectionDocs[i % sectionDocs.length]._id,
          name: `Article ${spec.key} ${String(i + 1).padStart(4, '0')}`,
          imageKey: `${prefix}/seed-${i + 1}.webp`,
          imageStorage: storage,
          purchasePrice: Math.round(salePrice * 0.6),
          salePrice,
          remainingQuantity: 5000 + Math.floor(random() * 5000),
          soldSeed: 0,
        };
      });
      // Produits de contention (concurrence) : stock minimal, réglé par
      // `concurrency.js` via la VRAIE route (`additionalStock`).
      for (let c = 1; c <= 3; c += 1) {
        products.push({
          _id: new Types.ObjectId(),
          organizationId: orgOid,
          sectionId: sectionDocs[0]._id,
          name: `Contention ${spec.key} ${c}`,
          imageKey: `${prefix}/contention-${c}.webp`,
          imageStorage: storage,
          purchasePrice: 600,
          salePrice: 1000,
          remainingQuantity: 1,
          soldSeed: 0,
          contention: true,
        });
      }

      // ── Historique de ventes (cohérent avec le stock) ─────────────────
      const sellers = members.filter((m) => m.role !== 'owner');
      const regular = products.filter((p) => !p.contention);
      const sales = [];
      for (let s = 0; s < spec.sales; s += 1) {
        const product = regular[Math.floor(random() * regular.length)];
        const seller = sellers[s % sellers.length];
        const quantity = 1 + Math.floor(random() * 3);
        const at = new Date(
          now - Math.floor(random() * profile.historyDays * DAY) - 60_000,
        );
        product.soldSeed += quantity;
        sales.push(
          doc(
            Sale,
            {
              organizationId: orgOid,
              productId: product._id,
              quantity,
              salePrice: product.salePrice,
              sellerId: new Types.ObjectId(seller.userId),
              productName: product.name,
              occurredAt: at,
            },
            at,
          ),
        );
      }
      const productDocs = products.map((p) =>
        doc(Product, {
          _id: p._id,
          organizationId: p.organizationId,
          sectionId: p.sectionId,
          name: p.name,
          imageKey: p.imageKey,
          imageStorage: p.imageStorage,
          purchasePrice: p.purchasePrice,
          salePrice: p.salePrice,
          initialQuantity: p.remainingQuantity + p.soldSeed,
          remainingQuantity: p.remainingQuantity,
        }),
      );
      await Product.collection.insertMany(productDocs);
      // 1-20F (facultatif, `LOAD_BIG_SECTION=<n>`) : un rayon SUPPLÉMENTAIRE
      // de n produits dans l'entreprise concentrée, sans vente, pour mesurer
      // la liste d'un grand rayon. Les rayons et produits du profil sont
      // inchangés ; ce rayon n'est jamais tiré par les autres scénarios.
      const bigCount = Number(process.env.LOAD_BIG_SECTION || 0);
      let bigSectionId = null;
      if (bigCount > 0 && spec.kind === 'concentrated') {
        const big = doc(Section, { organizationId: orgOid, name: 'Rayon géant' });
        await Section.collection.insertOne(big);
        bigSectionId = String(big._id);
        const bigDocs = [];
        for (let i = 0; i < bigCount; i += 1) {
          bigDocs.push(
            doc(
              Product,
              {
                organizationId: orgOid,
                sectionId: big._id,
                name: `Grand ${spec.key} ${String(i + 1).padStart(5, '0')}`,
                imageKey: `${prefix}/big-${i + 1}.webp`,
                imageStorage: storage,
                purchasePrice: 600,
                salePrice: 1000,
                initialQuantity: 100,
                remainingQuantity: 100,
              },
              new Date(now - (bigCount - i) * 1000),
            ),
          );
        }
        for (let i = 0; i < bigDocs.length; i += 5000)
          await Product.collection.insertMany(bigDocs.slice(i, i + 5000));
      }
      for (let i = 0; i < sales.length; i += 5000)
        await Sale.collection.insertMany(sales.slice(i, i + 5000));

      // ── Notifications (propriétaire et administrateurs) ───────────────
      const managers = members.filter((m) => m.role !== 'seller');
      const notifications = [];
      for (const manager of managers) {
        for (let n = 0; n < spec.notificationsPerManager; n += 1) {
          const sale =
            sales[(n * 7 + managers.indexOf(manager)) % sales.length];
          const read = random() < 0.7;
          const eventAt = new Date(now - Math.floor(random() * 2 * DAY));
          const readAt = read ? new Date(eventAt.getTime() + 60_000) : null;
          notifications.push(
            doc(
              Notification,
              {
                userId: new Types.ObjectId(manager.userId),
                organizationId: orgOid,
                category: 'sale-created',
                eventKey: `seed-sale-created:${sale._id}:${n}`,
                productId: sale.productId,
                saleId: sale._id,
                eventAt,
                readAt,
                // Rétention du centre après lecture (48 h pour une vente).
                expiresAt: readAt
                  ? new Date(readAt.getTime() + 48 * 60 * 60 * 1000)
                  : null,
              },
              eventAt,
            ),
          );
        }
      }
      for (let i = 0; i < notifications.length; i += 5000)
        await Notification.collection.insertMany(
          notifications.slice(i, i + 5000),
        );

      totals = {
        sections: totals.sections + sectionDocs.length,
        products: totals.products + productDocs.length,
        sales: totals.sales + sales.length,
        notifications: totals.notifications + notifications.length,
      };
      orgs.push({
        key: spec.key,
        kind: spec.kind,
        organizationId,
        sectionIds: sectionDocs.map((s) => String(s._id)),
        bigSectionId,
        productIds: regular.map((p) => String(p._id)),
        contentionProductIds: products
          .filter((p) => p.contention)
          .map((p) => String(p._id)),
      });
      for (const m of members)
        users.push({ ...m, org: spec.key, organizationId });
    }

    // ── Sessions (AVANT les mesures) ─────────────────────────────────────
    const sessions = [];
    for (const user of users) {
      const result = await auth.login({
        email: user.email,
        password: L.PASSWORD,
      });
      if (!result.access_token)
        throw new Error(`Session non obtenue : ${user.email}`);
      sessions.push({ ...user, token: result.access_token });
    }
    fs.writeFileSync(
      L.SESSIONS_FILE,
      JSON.stringify({ profile: profileName, orgs, sessions }, null, 2),
    );
    const summary = {
      profile: profileName,
      organizations: orgs.length,
      users: users.length,
      byRole: count(users.map((u) => u.role)),
      ...totals,
      indexedBySchema: indexed,
      seconds: Math.round((Date.now() - t0) / 1000),
    };
    process.stdout.write(`SEED ${JSON.stringify(summary)}\n`);
  } finally {
    await moduleRef.close();
  }
}

/** Document validé par le modèle réel, horodaté explicitement. */
function doc(Model, fields, at = new Date()) {
  const instance = new Model(fields);
  const error = instance.validateSync();
  if (error) throw error;
  const object = instance.toObject({ depopulate: true });
  if (Model.schema.options.timestamps) {
    object.createdAt = at;
    object.updatedAt = at;
  }
  return object;
}

function count(values) {
  return values.reduce((acc, v) => ({ ...acc, [v]: (acc[v] || 0) + 1 }), {});
}

/** Index déclarés des schémas `autoIndex` (comme Mongoose en production). */
async function ensureSchemaIndexes(connection) {
  const existing = new Set(
    (await connection.db.listCollections().toArray()).map((c) => c.name),
  );
  const indexed = [];
  for (const model of Object.values(connection.models)) {
    const name = model.collection.collectionName;
    if (!existing.has(name)) {
      await model.createCollection();
      existing.add(name);
    }
    if (
      model.schema.get('autoIndex') !== false &&
      model.schema.indexes().length > 0
    ) {
      await model.createIndexes();
      indexed.push(name);
    }
  }
  return indexed.sort();
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(`Peuplement interrompu : ${error && error.stack}`);
      process.exit(1);
    },
  );
}
