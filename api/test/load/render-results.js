#!/usr/bin/env node
/**
 * 1-20A — Tableaux Markdown à partir des résultats de `run-campaign.js`.
 *
 *   node api/test/load/render-results.js <dossier> [label…]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const labels = process.argv.slice(3);
const files = fs
  .readdirSync(dir)
  .filter((f) => /\.json$/.test(f) && !/\.k6\.json$/.test(f))
  .filter((f) => !labels.length || labels.includes(f.replace(/\.json$/, '')));

const fmt = (v) => (v === null || v === undefined ? '—' : String(v));
const lines = [
  '| Palier | VU | Débit offert → obtenu (it/s) | req/s | Route la plus lente (n, p50/p95/p99 ms) | Erreurs inattendues / refus / 429 | API cœurs (moy.) | Retard boucle p99 méd. (ms) | mongod cœurs | Lat. Mongo L/É (ms) | Travaux en attente max (âge s) | k6 cœurs | Mém. libre min (Mo) | Seuil |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
];
for (const file of files) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch {
    continue;
  }
  if (!Array.isArray(data.results)) continue;
  for (const r of data.results) {
    const [name, worst] = Object.entries(r.k6.routes).sort(
      (a, b) => b[1].p95 - a[1].p95,
    )[0] || ['—', {}];
    lines.push(
      `| ${r.label} | ${r.vus} | ${fmt(r.k6.offeredIterPerS)} → ${r.k6.obtainedIterPerS} | ${r.k6.reqPerS} | ${name} (${worst.n}, ${worst.p50}/${worst.p95}/${worst.p99}) | ${r.k6.unexpectedErrors} / ${r.k6.businessRefusals} / ${r.k6.rateLimited} | ${fmt(r.proc.apiCoresAvg)} | ${fmt(r.api.eldP99MsMedian)} | ${fmt(r.proc.mongodCoresAvg)} | ${r.db.reads.avgMs} / ${r.db.writes.avgMs} | ${fmt(r.db.pendingJobsMax)} (${fmt(r.db.oldestPendingJobAgeSMax)}) | ${fmt(r.proc.k6CoresAvg)} | ${fmt(r.proc.hostFreeMbMin)} | ${r.verdict.reasons.length ? r.verdict.reasons.join(' ; ') : 'non'} |`,
    );
  }
}
console.log(lines.join('\n'));
