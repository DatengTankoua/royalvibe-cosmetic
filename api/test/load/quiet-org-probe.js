#!/usr/bin/env node
/**
 * 1-20B — Entreprise peu active pendant la charge d'une autre (TEST, local).
 *
 *   node api/test/load/quiet-org-probe.js --org=std2 [--every-s=5]
 *     [--duration=60] [--timeout-s=180] [--out=<f.json>]
 *
 * Un vendeur de `--org` vend toutes les `--every-s` secondes ; le
 * propriétaire relit `GET /notifications?limit=50` (route réelle). La vue
 * n'expose pas l'identifiant de la vente : les ventes de la sonde étant
 * les SEULES de l'entreprise pendant la mesure (charge k6 ailleurs), chaque
 * nouvelle notification `sale-created` est associée, dans l'ordre de
 * création, à la vente de même rang. Délai mesuré côté utilisateur
 * (inclut l'intervalle du traitement de fond et le regroupement éventuel du
 * centre : aucun pour les ventes). Ventes non vues après `--timeout-s` :
 * comptées « non reçues à temps ».
 */
'use strict';

require('../recipe/preload.cjs');
const fs = require('fs');
const crypto = require('crypto');
const L = require('./load-common');

function parse() {
  const o = { org: 'std2', everyS: 5, duration: 60, timeoutS: 180, out: null };
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (!m) continue;
    const k = m[1].replace(/-(.)/g, (_, c) => c.toUpperCase());
    o[k] = Number.isNaN(Number(m[2])) ? m[2] : Number(m[2]);
  }
  return o;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (v, p) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) / 1000;
};

async function main() {
  const o = parse();
  L.requireRunningState();
  const { orgs, sessions } = L.readJson(L.SESSIONS_FILE);
  const org = orgs.find((x) => x.key === o.org);
  if (!org) throw new Error(`Organisation inconnue : ${o.org}`);
  const owner = sessions.find((s) => s.org === o.org && s.role === 'owner');
  const seller = sessions.find((s) => s.org === o.org && s.role === 'seller');

  const list = async () => {
    const r = await L.api('GET', '/notifications?limit=50', {
      token: owner.token,
    });
    return r.status === 200 && r.body && Array.isArray(r.body.items)
      ? r.body.items.filter((n) => n.category === 'sale-created')
      : [];
  };
  const before = new Set((await list()).map((n) => n.id));
  const seen = new Map();
  const poll = async () => {
    for (const n of await list()) {
      if (!before.has(n.id) && !seen.has(n.id)) seen.set(n.id, Date.now());
    }
  };

  const sales = [];
  const end = Date.now() + o.duration * 1000;
  let i = 0;
  let nextSale = Date.now();
  while (Date.now() < end) {
    if (Date.now() >= nextSale) {
      const t = Date.now();
      nextSale = t + o.everyS * 1000;
      const r = await L.api('POST', '/sales', {
        token: seller.token,
        body: {
          productId: org.productIds[(i * 7) % org.productIds.length],
          quantity: 1,
          salePrice: 1000,
          clientOperationId: crypto.randomUUID(),
        },
      });
      i += 1;
      if (r.status === 201) sales.push({ id: r.body._id, at: t, seenAt: null });
    }
    await poll();
    await delay(500);
  }
  const deadline = Date.now() + o.timeoutS * 1000;
  while (Date.now() < deadline && seen.size < sales.length) {
    await poll();
    await delay(500);
  }
  // Ordre de création (identifiant croissant) ↔ ordre des ventes.
  const ordered = [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  ordered.forEach(([, at], k) => {
    if (sales[k]) sales[k].seenAt = at;
  });
  const delays = sales.filter((s) => s.seenAt).map((s) => s.seenAt - s.at);
  const result = {
    at: new Date().toISOString(),
    options: { ...o, out: o.out ? 'fichier' : null },
    sales: sales.length,
    received: delays.length,
    notReceivedInTime: sales.length - delays.length,
    unmatchedNotifications: Math.max(0, seen.size - sales.length),
    delayS: {
      p50: q(delays, 0.5),
      p95: q(delays, 0.95),
      max: q(delays, 1),
    },
  };
  const text = JSON.stringify(result, null, 2);
  if (o.out) fs.writeFileSync(o.out, text);
  console.log(text);
}

main().catch((e) => {
  console.error(`Sonde interrompue : ${e && e.stack}`);
  process.exit(1);
});
