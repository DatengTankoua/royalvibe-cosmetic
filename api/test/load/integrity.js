#!/usr/bin/env node
/**
 * 1-20A — Invariants métier après charge (TEST, LECTURE SEULE).
 *
 *   node api/test/load/integrity.js [--since=<ISO>] [--wait-drain=60] [--out=<f>]
 *
 * Base : uniquement l'instance éphémère de la stack (`assertLoadUri`).
 * 1. Stock : jamais négatif ; `remaining = initial − Σ quantités des ventes`.
 * 2. Ventes et audit : chaque vente a son audit `sold` ; chaque `sold`
 *    désigne une vente existante ou annulée (`sale_cancelled`).
 * 3. Notifications : aucun doublon (eventKey, destinataire) ; aucun
 *    destinataire hors de l'organisation ; vente : ni l'auteur, ni une autre
 *    organisation, exactement un exemplaire par destinataire éligible.
 * 4. Adhésions (`membership-check.json` de `concurrency.js`) : une seule
 *    adhésion et une seule notification « nouveau membre » par gestionnaire.
 * 5. Travaux : vidange (attente jusqu'à `--wait-drain` s), livraisons push
 *    sans doublon ni appareil d'une autre organisation.
 * 6. Activités (limite connue 1-19A) : comptées séparément.
 */
'use strict';

require('../recipe/preload.cjs');
const fs = require('fs');
const L = require('./load-common');

const { R } = L;
const arg = (name, fallback) => {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  return m ? m.slice(name.length + 3) : fallback;
};

async function main() {
  const state = L.requireRunningState();
  const since = new Date(arg('since', state.startedAt));
  const waitDrain = Number(arg('wait-drain', '60'));
  const { MongoClient, ObjectId } = R.apiRequire('mongoose').mongo;
  const client = new MongoClient(L.assertLoadUri(state.mongodbUri), {
    maxPoolSize: 2,
  });
  await client.connect();
  const db = client.db(L.DB_NAME);
  const report = {
    at: new Date().toISOString(),
    since: since.toISOString(),
    checks: {},
  };
  const check = (name, ok, details) => {
    report.checks[name] = { ok, ...details };
  };
  try {
    // ── 5a. Vidange d'abord (les notifications en dépendent) ───────────
    const drainStart = Date.now();
    let pending = null;
    while (true) {
      pending = {
        jobs: await db
          .collection('push_jobs')
          .countDocuments({ status: 'pending' }),
        deliveriesDue: await db.collection('push_deliveries').countDocuments({
          status: { $in: ['pending', 'sending'] },
          nextAttemptAt: { $lte: new Date() },
        }),
      };
      if (
        (pending.jobs === 0 && pending.deliveriesDue === 0) ||
        Date.now() - drainStart > waitDrain * 1000
      )
        break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const notYetDue = await db.collection('push_deliveries').countDocuments({
      status: 'pending',
      nextAttemptAt: { $gt: new Date() },
    });
    check('drain', pending.jobs === 0 && pending.deliveriesDue === 0, {
      ...pending,
      deliveriesWaitingForGroupingWindow: notYetDue,
      waitedS: Math.round((Date.now() - drainStart) / 1000),
    });

    // ── 1. Stock ────────────────────────────────────────────────────────
    const soldByProduct = new Map(
      (
        await db
          .collection('sales')
          .aggregate([
            { $group: { _id: '$productId', q: { $sum: '$quantity' } } },
          ])
          .toArray()
      ).map((r) => [String(r._id), r.q]),
    );
    const products = await db
      .collection('products')
      .find(
        {},
        {
          projection: {
            initialQuantity: 1,
            remainingQuantity: 1,
            organizationId: 1,
          },
        },
      )
      .toArray();
    const negative = products.filter((p) => p.remainingQuantity < 0).length;
    const mismatched = products.filter(
      (p) =>
        p.remainingQuantity !==
        p.initialQuantity - (soldByProduct.get(String(p._id)) || 0),
    );
    check('stock', negative === 0 && mismatched.length === 0, {
      products: products.length,
      negative,
      mismatched: mismatched.length,
      sample: mismatched.slice(0, 3).map((p) => String(p._id)),
    });

    // Ventes rattachées à un produit d'une autre organisation.
    const productOrg = new Map(
      products.map((p) => [String(p._id), String(p.organizationId)]),
    );
    const recentSales = await db
      .collection('sales')
      .find(
        { createdAt: { $gte: since } },
        { projection: { productId: 1, organizationId: 1, sellerId: 1 } },
      )
      .toArray();
    const crossSales = recentSales.filter(
      (s) =>
        productOrg.has(String(s.productId)) &&
        productOrg.get(String(s.productId)) !== String(s.organizationId),
    ).length;

    // ── 2. Ventes ↔ audit ──────────────────────────────────────────────
    const audits = await db
      .collection('auditlogs')
      .find(
        {
          createdAt: { $gte: since },
          action: { $in: ['sold', 'sale_cancelled'] },
        },
        { projection: { action: 1, details: 1 } },
      )
      .toArray();
    const soldIds = new Set(
      audits
        .filter((a) => a.action === 'sold')
        .map((a) => String(a.details.saleId)),
    );
    const cancelledIds = new Set(
      audits
        .filter((a) => a.action === 'sale_cancelled')
        .map((a) => String(a.details.saleId)),
    );
    const existingIds = new Set(recentSales.map((s) => String(s._id)));
    const salesWithoutAudit = recentSales.filter(
      (s) => !soldIds.has(String(s._id)),
    ).length;
    const orphanSold = [...soldIds].filter(
      (id) => !existingIds.has(id) && !cancelledIds.has(id),
    ).length;
    const cancelledStillPresent = [...cancelledIds].filter((id) =>
      existingIds.has(id),
    ).length;
    check(
      'salesAudit',
      salesWithoutAudit === 0 &&
        orphanSold === 0 &&
        cancelledStillPresent === 0 &&
        crossSales === 0,
      {
        salesSince: recentSales.length,
        soldAudits: soldIds.size,
        cancelledAudits: cancelledIds.size,
        salesWithoutAudit,
        orphanSold,
        cancelledStillPresent,
        crossOrganizationSales: crossSales,
      },
    );

    // ── 3. Notifications ───────────────────────────────────────────────
    const duplicates = await db
      .collection('notifications')
      .aggregate([
        { $group: { _id: { k: '$eventKey', u: '$userId' }, n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $count: 'n' },
      ])
      .toArray();
    const memberships = await db
      .collection('organizationmemberships')
      .find(
        {},
        {
          projection: {
            userId: 1,
            organizationId: 1,
            role: 1,
            status: 1,
            permissions: 1,
          },
        },
      )
      .toArray();
    const memberKey = new Set(
      memberships.map((m) => `${m.organizationId}:${m.userId}`),
    );
    const recentNotifications = await db
      .collection('notifications')
      .find(
        { createdAt: { $gte: since } },
        {
          projection: {
            userId: 1,
            organizationId: 1,
            category: 1,
            saleId: 1,
            eventKey: 1,
          },
        },
      )
      .toArray();
    const foreignRecipients = recentNotifications.filter(
      (n) => !memberKey.has(`${n.organizationId}:${n.userId}`),
    ).length;

    // Ventes : exactement un exemplaire par destinataire éligible (travail
    // réparti), jamais l'auteur, jamais une autre organisation.
    const saleById = new Map(recentSales.map((s) => [String(s._id), s]));
    const jobs = await db
      .collection('push_jobs')
      .find(
        { createdAt: { $gte: since }, category: 'sale-created' },
        { projection: { saleId: 1, status: 1, outcome: 1 } },
      )
      .toArray();
    const eligibleByOrg = new Map();
    for (const m of memberships) {
      if (m.status !== 'active') continue;
      const grants =
        m.role === 'owner' ||
        m.role === 'admin' ||
        (m.permissions || []).includes('sales.notifications');
      if (!grants) continue;
      const k = String(m.organizationId);
      if (!eligibleByOrg.has(k)) eligibleByOrg.set(k, []);
      eligibleByOrg.get(k).push(String(m.userId));
    }
    const notifBySale = new Map();
    for (const n of recentNotifications.filter(
      (x) => x.category === 'sale-created',
    )) {
      const k = String(n.saleId);
      if (!notifBySale.has(k)) notifBySale.set(k, []);
      notifBySale.get(k).push(n);
    }
    let authorNotified = 0;
    let wrongOrg = 0;
    let missing = 0;
    let extra = 0;
    let checkedSales = 0;
    for (const job of jobs.filter((j) => j.status === 'dispatched')) {
      const sale = saleById.get(String(job.saleId));
      const list = notifBySale.get(String(job.saleId)) || [];
      if (!sale) continue; // annulée avant/pendant la répartition
      checkedSales += 1;
      const expected = (
        eligibleByOrg.get(String(sale.organizationId)) || []
      ).filter((u) => u !== String(sale.sellerId));
      for (const n of list) {
        if (String(n.userId) === String(sale.sellerId)) authorNotified += 1;
        if (String(n.organizationId) !== String(sale.organizationId))
          wrongOrg += 1;
      }
      const got = new Set(list.map((n) => String(n.userId)));
      missing += expected.filter((u) => !got.has(u)).length;
      extra += list.filter((n) => !expected.includes(String(n.userId))).length;
    }
    check(
      'notifications',
      duplicates.length === 0 &&
        foreignRecipients === 0 &&
        authorNotified === 0 &&
        wrongOrg === 0 &&
        missing === 0 &&
        extra === 0,
      {
        notificationsSince: recentNotifications.length,
        duplicateEventRecipient: duplicates[0] ? duplicates[0].n : 0,
        foreignRecipients,
        saleJobs: jobs.length,
        saleJobsDispatched: jobs.filter((j) => j.status === 'dispatched')
          .length,
        saleJobsCancelled: jobs.filter((j) => j.status === 'cancelled').length,
        salesChecked: checkedSales,
        authorNotified,
        wrongOrganization: wrongOrg,
        missingRecipients: missing,
        unexpectedRecipients: extra,
      },
    );

    // ── 4. Adhésions ───────────────────────────────────────────────────
    const mc = L.readJson(`${L.STATE_DIR}/membership-check.json`);
    if (mc) {
      const orgOid = new ObjectId(mc.organizationId);
      const joined = await db
        .collection('organizationmemberships')
        .find({
          organizationId: orgOid,
          userId: { $in: mc.joiners.map((u) => new ObjectId(u)) },
        })
        .toArray();
      const managers = memberships
        .filter(
          (m) =>
            String(m.organizationId) === mc.organizationId &&
            m.status === 'active' &&
            ['owner', 'admin'].includes(m.role),
        )
        .map((m) => String(m.userId));
      let dup = 0;
      let miss = 0;
      let foreign = 0;
      for (const m of joined) {
        const list = await db
          .collection('notifications')
          .find({ eventKey: `member-joined:${m._id}` })
          .toArray();
        const users = list.map((n) => String(n.userId));
        dup += users.length - new Set(users).size;
        miss += managers.filter((u) => !users.includes(u)).length;
        foreign += list.filter(
          (n) =>
            String(n.organizationId) !== mc.organizationId ||
            !managers.includes(String(n.userId)),
        ).length;
      }
      check(
        'membership',
        joined.length === mc.joiners.length &&
          dup === 0 &&
          miss === 0 &&
          foreign === 0,
        {
          joiners: mc.joiners.length,
          memberships: joined.length,
          duplicateNotifications: dup,
          missingManagers: miss,
          foreignRecipients: foreign,
        },
      );
    }

    // ── 5b. Livraisons push ────────────────────────────────────────────
    const deliveryDup = await db
      .collection('push_deliveries')
      .aggregate([
        {
          $group: {
            _id: { j: '$jobId', s: '$subscriptionId' },
            n: { $sum: 1 },
          },
        },
        { $match: { n: { $gt: 1 } } },
        { $count: 'n' },
      ])
      .toArray();
    const subs = new Map(
      (
        await db
          .collection('push_subscriptions')
          .find({}, { projection: { organizationId: 1 } })
          .toArray()
      ).map((s) => [String(s._id), String(s.organizationId)]),
    );
    const deliveries = await db
      .collection('push_deliveries')
      .find(
        { createdAt: { $gte: since } },
        {
          projection: {
            jobId: 1,
            subscriptionId: 1,
            status: 1,
            nextAttemptAt: 1,
            sentAt: 1,
          },
        },
      )
      .toArray();
    const jobOrg = new Map(
      (
        await db
          .collection('push_jobs')
          .find(
            { createdAt: { $gte: since } },
            { projection: { organizationId: 1 } },
          )
          .toArray()
      ).map((j) => [String(j._id), String(j.organizationId)]),
    );
    const foreignDevices = deliveries.filter(
      (d) =>
        jobOrg.has(String(d.jobId)) &&
        subs.get(String(d.subscriptionId)) !== jobOrg.get(String(d.jobId)),
    ).length;
    const byStatus = deliveries.reduce(
      (a, d) => ({ ...a, [d.status]: (a[d.status] || 0) + 1 }),
      {},
    );
    check('pushDeliveries', deliveryDup.length === 0 && foreignDevices === 0, {
      deliveries: deliveries.length,
      byStatus,
      duplicates: deliveryDup[0] ? deliveryDup[0].n : 0,
      foreignDevices,
    });

    // ── 6. Activités (limite connue : enregistrées APRÈS l'action) ──────
    const activityJobs = await db.collection('push_jobs').countDocuments({
      createdAt: { $gte: since },
      category: 'member-activity',
    });
    const activityNotes = await db.collection('notifications').countDocuments({
      createdAt: { $gte: since },
      category: 'member-activity',
    });
    report.memberActivity = {
      jobs: activityJobs,
      notifications: activityNotes,
      note: 'best effort après l’action (1-19A §3) : un arrêt du processus entre action et enregistrement perd la notification ; non vérifiable exactement par comptage.',
    };

    report.ok = Object.values(report.checks).every((c) => c.ok);
  } finally {
    await client.close();
  }
  const text = JSON.stringify(report, null, 2);
  const out = arg('out', null);
  if (out) fs.writeFileSync(out, text);
  console.log(text);
  process.exitCode = report.ok ? 0 : 2;
}

main().catch((error) => {
  console.error(`Intégrité interrompue : ${error && error.stack}`);
  process.exit(1);
});
