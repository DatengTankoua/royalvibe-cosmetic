#!/usr/bin/env node
/**
 * 1-20E — Coût MongoDB des requêtes de la page Ventes (LECTURE SEULE, base
 * éphémère de la stack de charge) : `explain('executionStats')` de
 * l'ancien contrat (`GET /sales` : tout l'historique trié) et du nouveau
 * (`GET /sales/history` : comptage + page de 21 documents, première page et
 * page éloignée), pour l'entreprise la plus volumineuse et un vendeur.
 *
 *   node api/test/load/sales-history-explain.js [--out=<f.json>]
 */
'use strict';

require('../recipe/preload.cjs');
const fs = require('fs');
const L = require('./load-common');

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

async function main() {
  const state = L.requireRunningState();
  const { MongoClient } = L.R.apiRequire('mongoose').mongo;
  const client = new MongoClient(L.assertLoadUri(state.mongodbUri), {
    maxPoolSize: 2,
  });
  await client.connect();
  const sales = client.db(L.DB_NAME).collection('sales');
  const { orgs, sessions } = L.readJson(L.SESSIONS_FILE);
  const out = { at: new Date().toISOString(), indexes: [], cases: {} };
  try {
    out.indexes = (await sales.listIndexes().toArray()).map((i) => i.name);
    const counts = await Promise.all(
      orgs.map(async (o) => ({
        o,
        n: await sales.countDocuments({
          organizationId: new (L.R.apiRequire('mongoose').Types.ObjectId)(
            o.organizationId,
          ),
        }),
      })),
    );
    const { o: org, n } = counts.sort((a, b) => b.n - a.n)[0];
    const { Types } = L.R.apiRequire('mongoose');
    const orgId = new Types.ObjectId(org.organizationId);
    const seller = sessions.find(
      (s) => s.org === org.key && s.role === 'seller',
    );
    const sellerId = new Types.ObjectId(seller.userId);
    out.organization = { key: org.key, sales: n };

    out.cases.legacyAll = summarize(
      await sales
        .find({ organizationId: orgId })
        .sort({ createdAt: -1 })
        .explain('executionStats'),
    );
    out.cases.legacyOwn = summarize(
      await sales
        .find({ organizationId: orgId, sellerId })
        .sort({ createdAt: -1 })
        .explain('executionStats'),
    );
    out.cases.pagedFirst = summarize(
      await sales
        .find({ organizationId: orgId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(21)
        .explain('executionStats'),
    );
    out.cases.pagedOwnFirst = summarize(
      await sales
        .find({ organizationId: orgId, sellerId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(21)
        .explain('executionStats'),
    );
    // Page éloignée : curseur après ~50 pages.
    const deep = await sales
      .find({ organizationId: orgId })
      .sort({ createdAt: -1, _id: -1 })
      .skip(Math.min(n - 1, Number(process.env.FAR_DEPTH || 1000)))
      .limit(1)
      .next();
    if (deep) {
      out.cases.pagedFar = summarize(
        await sales
          .find({
            organizationId: orgId,
            // Même forme que `SalesService.findHistoryPage`.
            createdAt: { $lte: deep.createdAt },
            $or: [
              { createdAt: { $lt: deep.createdAt } },
              { _id: { $lt: deep._id } },
            ],
          })
          .sort({ createdAt: -1, _id: -1 })
          .limit(21)
          .explain('executionStats'),
      );
    }
    const t = performance.now();
    await sales.countDocuments({ organizationId: orgId });
    out.cases.count = { ms: Math.round((performance.now() - t) * 10) / 10 };
  } finally {
    await client.close();
  }
  const text = JSON.stringify(out, null, 2);
  const arg = process.argv.find((a) => a.startsWith('--out='));
  if (arg) fs.writeFileSync(arg.slice(6), text);
  console.log(text);
}

main().catch((e) => {
  console.error(e && e.stack);
  process.exit(1);
});
