#!/usr/bin/env node
/**
 * 1-20F — Coût MongoDB des requêtes de la liste d'un rayon (base éphémère
 * de la stack de charge) : `explain('executionStats')` de l'ancien contrat
 * (`GET /products?sectionId=` : tout le rayon trié) et du nouveau (page de
 * 25 documents, page éloignée, recherche, comptage), sur le plus grand rayon
 * du jeu de données.
 *
 * `--synthetic=<n>` : ajoute TEMPORAIREMENT un rayon de n produits à la
 * plus grande entreprise (base éphémère seulement), mesure les mêmes
 * requêtes avec l'index de la page puis avec l'ancien index seul (hint),
 * et SUPPRIME ce rayon et ses produits avant de terminer (même en échec).
 *
 *   node api/test/load/products-page-explain.js [--synthetic=5000] [--out=<f.json>]
 */
'use strict';

require('../recipe/preload.cjs');
const fs = require('fs');
const L = require('./load-common');

const PAGE_INDEX = 'organizationId_1_sectionId_1_deletedAt_1_createdAt_-1__id_-1';
const OLD_INDEX = { organizationId: 1, sectionId: 1, deletedAt: 1 };

function summarize(explain) {
  const plan = JSON.stringify(explain.queryPlanner.winningPlan);
  const index = /"indexName":"([^"]+)"/.exec(plan);
  return {
    index: index ? index[1] : null,
    inMemorySort: plan.includes('"SORT"'),
    docsExamined: explain.executionStats.totalDocsExamined,
    keysExamined: explain.executionStats.totalKeysExamined,
    returned: explain.executionStats.nReturned,
    ms: explain.executionStats.executionTimeMillis,
  };
}

async function measure(products, scope, hint) {
  const withHint = (cursor) => (hint ? cursor.hint(hint) : cursor);
  const cases = {};
  cases.legacyAll = summarize(
    await withHint(products.find(scope).sort({ createdAt: -1 })).explain(
      'executionStats',
    ),
  );
  cases.pagedFirst = summarize(
    await withHint(
      products.find(scope).sort({ createdAt: -1, _id: -1 }).limit(25),
    ).explain('executionStats'),
  );
  const rows = await products
    .find(scope)
    .sort({ createdAt: -1, _id: -1 })
    .project({ createdAt: 1, name: 1 })
    .toArray();
  const deep = rows[Math.max(0, rows.length - 30)];
  if (deep) {
    cases.pagedFar = summarize(
      await withHint(
        products
          .find({
            ...scope,
            // Même forme que `productPageFilter`.
            createdAt: { $lte: deep.createdAt },
            $or: [
              { createdAt: { $lt: deep.createdAt } },
              { _id: { $lt: deep._id } },
            ],
          })
          .sort({ createdAt: -1, _id: -1 })
          .limit(25),
      ).explain('executionStats'),
    );
    const escaped = deep.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cases.search = summarize(
      await withHint(
        products
          .find({ ...scope, name: new RegExp(escaped, 'i') })
          .sort({ createdAt: -1, _id: -1 })
          .limit(25),
      ).explain('executionStats'),
    );
  }
  const t = performance.now();
  await products.countDocuments(scope, hint ? { hint } : {});
  cases.count = { ms: Math.round((performance.now() - t) * 10) / 10 };
  return { products: rows.length, cases };
}

async function main() {
  const state = L.requireRunningState();
  const { mongo, Types } = L.R.apiRequire('mongoose');
  const client = new mongo.MongoClient(L.assertLoadUri(state.mongodbUri), {
    maxPoolSize: 2,
  });
  await client.connect();
  const db = client.db(L.DB_NAME);
  const products = db.collection('products');
  const arg = (name) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const synthetic = Number(arg('synthetic') || 0);
  const out = { at: new Date().toISOString(), indexes: [], real: null };
  const sectionOid = new Types.ObjectId();
  try {
    out.indexes = (await products.listIndexes().toArray()).map((i) => i.name);
    const [largest] = await products
      .aggregate([
        { $match: { deletedAt: null } },
        {
          $group: {
            _id: { o: '$organizationId', s: '$sectionId' },
            n: { $sum: 1 },
          },
        },
        { $sort: { n: -1 } },
        { $limit: 1 },
      ])
      .toArray();
    const scope = {
      organizationId: largest._id.o,
      sectionId: largest._id.s,
      deletedAt: null,
    };
    out.real = await measure(products, scope);
    out.real.oldIndexOnly = (await measure(products, scope, OLD_INDEX)).cases;
    if (synthetic > 0) {
      const now = Date.now();
      await products.insertMany(
        Array.from({ length: synthetic }, (_, i) => ({
          organizationId: largest._id.o,
          sectionId: sectionOid,
          name: `Synthèse 1-20F ${String(i).padStart(5, '0')}`,
          purchasePrice: 1,
          salePrice: 2,
          initialQuantity: 10,
          remainingQuantity: 10,
          deletedAt: null,
          imageKey: null,
          imageStorage: null,
          createdAt: new Date(now - i * 1000),
          updatedAt: new Date(now - i * 1000),
        })),
      );
      const sScope = { ...scope, sectionId: sectionOid };
      out.synthetic = await measure(products, sScope);
      out.synthetic.oldIndexOnly = (
        await measure(products, sScope, OLD_INDEX)
      ).cases;
    }
    out.pageIndexPresent = out.indexes.includes(PAGE_INDEX);
  } finally {
    if (synthetic > 0) {
      const removed = await products.deleteMany({ sectionId: sectionOid });
      out.syntheticRemoved = removed.deletedCount;
    }
    await client.close();
  }
  const text = JSON.stringify(out, null, 2);
  const file = arg('out');
  if (file) fs.writeFileSync(file, text);
  console.log(text);
}

main().catch((e) => {
  console.error(e && e.stack);
  process.exit(1);
});
