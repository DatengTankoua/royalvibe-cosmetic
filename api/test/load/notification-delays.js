#!/usr/bin/env node
/**
 * 1-20A — Délais du dispatcher, LECTURE SEULE, sur une fenêtre d'événements.
 *
 *   node api/test/load/notification-delays.js --from=<ISO> --to=<ISO> [--out=<f>]
 *
 * Pour les travaux créés dans la fenêtre, par catégorie :
 * - `dispatch` : `processedAt − createdAt` (attente dans l'outbox) ;
 * - `center`   : création de la notification persistante − `eventAt` ;
 * - `grouping` : `nextAttemptAt − eventAt` des livraisons push = délai
 *   VOLONTAIRE (fenêtre d'une minute des ventes et activités) ;
 * - `pushLate` : `sentAt − nextAttemptAt` = retard RÉELLEMENT dû à la
 *   charge (transport simulé : aucun délai réseau).
 */
'use strict';

require('../recipe/preload.cjs');
const fs = require('fs');
const L = require('./load-common');

const arg = (n) => {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  return m ? m.slice(n.length + 3) : null;
};
const q = (v, p) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return (
    Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] / 100) / 10
  );
};
const stats = (v) => ({
  n: v.length,
  p50S: q(v, 0.5),
  p95S: q(v, 0.95),
  p99S: q(v, 0.99),
  maxS: q(v, 1),
});

async function main() {
  const state = L.requireRunningState();
  const from = new Date(arg('from'));
  const to = new Date(arg('to') || Date.now());
  const { MongoClient } = L.R.apiRequire('mongoose').mongo;
  const client = new MongoClient(L.assertLoadUri(state.mongodbUri), {
    maxPoolSize: 2,
  });
  await client.connect();
  const db = client.db(L.DB_NAME);
  try {
    const jobs = await db
      .collection('push_jobs')
      .find(
        { createdAt: { $gte: from, $lte: to } },
        {
          projection: {
            category: 1,
            createdAt: 1,
            processedAt: 1,
            eventAt: 1,
            eventKey: 1,
            status: 1,
          },
        },
      )
      .toArray();
    const byCat = {};
    for (const j of jobs) (byCat[j.category] ||= []).push(j);
    const result = {
      from: from.toISOString(),
      to: to.toISOString(),
      categories: {},
    };
    // 1-20B : débit entrant (travaux créés) et sortant (travaux clos) de la
    // fenêtre, hors regroupements (créés déjà clos, sans processedAt).
    const seconds = Math.max(1, (to - from) / 1000);
    const processedInWindow = await db.collection('push_jobs').countDocuments({
      processedAt: { $gte: from, $lte: to },
    });
    const pendingNow = await db
      .collection('push_jobs')
      .countDocuments({ status: 'pending' });
    const created = jobs.filter(
      (j) => !(j.status === 'dispatched' && !j.processedAt),
    ).length;
    result.flow = {
      windowS: Math.round(seconds),
      createdPerS: Math.round((created / seconds) * 100) / 100,
      processedPerS: Math.round((processedInWindow / seconds) * 100) / 100,
      created,
      processed: processedInWindow,
      pendingAtRead: pendingNow,
    };
    for (const [cat, list] of Object.entries(byCat)) {
      const keys = list.map((j) => j.eventKey);
      const notes = await db
        .collection('notifications')
        .find(
          { eventKey: { $in: keys } },
          { projection: { eventKey: 1, createdAt: 1 } },
        )
        .toArray();
      const firstNote = new Map();
      for (const n of notes) {
        const t = firstNote.get(n.eventKey);
        if (!t || n.createdAt < t) firstNote.set(n.eventKey, n.createdAt);
      }
      const ids = list.map((j) => j._id);
      const deliveries = await db
        .collection('push_deliveries')
        .find(
          { jobId: { $in: ids } },
          {
            projection: {
              jobId: 1,
              nextAttemptAt: 1,
              sentAt: 1,
              status: 1,
              createdAt: 1,
            },
          },
        )
        .toArray();
      const jobById = new Map(list.map((j) => [String(j._id), j]));
      const processed = list.filter((j) => j.processedAt);
      result.categories[cat] = {
        jobs: list.length,
        pendingAtRead: list.filter((j) => j.status === 'pending').length,
        dispatch: stats(processed.map((j) => j.processedAt - j.createdAt)),
        center: stats(
          list
            .filter((j) => firstNote.has(j.eventKey))
            .map((j) => firstNote.get(j.eventKey) - j.eventAt),
        ),
        grouping: stats(
          deliveries.map(
            (d) => d.nextAttemptAt - jobById.get(String(d.jobId)).eventAt,
          ),
        ),
        pushLate: stats(
          deliveries
            .filter((d) => d.sentAt)
            .map((d) => Math.max(0, d.sentAt - d.nextAttemptAt)),
        ),
        deliveries: deliveries.length,
        deliveriesSent: deliveries.filter((d) => d.sentAt).length,
      };
    }
    const text = JSON.stringify(result, null, 2);
    if (arg('out')) fs.writeFileSync(arg('out'), text);
    console.log(text);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e && e.stack);
  process.exit(1);
});
