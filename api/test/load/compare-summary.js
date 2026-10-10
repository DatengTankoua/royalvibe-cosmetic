#!/usr/bin/env node
/**
 * 1-20B — Synthèse avant/après d'un dossier `compare-1-20b.sh`.
 *
 *   node api/test/load/compare-summary.js <OUT> [groupe…]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const out = process.argv[2];
const groups = process.argv.slice(3);
const read = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

for (const dir of fs.readdirSync(out).sort()) {
  const full = path.join(out, dir);
  if (!fs.statSync(full).isDirectory()) continue;
  if (groups.length && !groups.some((g) => dir.startsWith(g))) continue;
  console.log(`\n## ${dir}`);
  const cond = fs.existsSync(path.join(full, 'conditions.txt'))
    ? fs.readFileSync(path.join(full, 'conditions.txt'), 'utf8').trim()
    : '';
  console.log(`conditions : ${cond}`);
  for (const f of fs
    .readdirSync(full)
    .filter((x) => /^[a-z0-9-]+\.json$/.test(x))) {
    const data = read(path.join(full, f));
    if (!data || !Array.isArray(data.results)) continue;
    for (const r of data.results) {
      const routes = Object.entries(r.k6.routes)
        .map(([n, v]) => `${n} ${v.p50}/${v.p95}/${v.p99}`)
        .join(' ; ');
      console.log(
        `${r.label}@${r.vus} offert ${r.k6.offeredIterPerS ?? '—'} → injecté ${r.k6.obtainedIterPerS} it/s, ${r.k6.reqPerS} req/s | inattendues ${r.k6.unexpectedErrors} (journalisées ${r.k6.unexpectedLogged ?? 0}) refus ${r.k6.businessRefusals} 429 ${r.k6.rateLimited} | API ${r.proc.apiCoresAvg} cœurs (max ${r.proc.apiCoresMax}), RSS ${r.api.rssMbMax} Mo, tas ${r.api.heapUsedMbMax} Mo, boucle ${r.api.eldP99MsMedian} ms, signatures ${r.api.signatures ?? '—'} | file max ${r.db.pendingJobsMax} (âge ${r.db.oldestPendingJobAgeSMax} s), envois en retard max ${r.db.dueDeliveriesMax} (${r.db.oldestDueDeliveryLateSMax} s) | libre ${r.proc.hostFreeMbMin} Mo | ${routes}${r.verdict.reasons.length ? ` ⇒ ${r.verdict.reasons.join(', ')}` : ''}`,
      );
    }
  }
  const delays = read(path.join(full, 'delays.json'));
  if (delays) {
    console.log(`flux : ${JSON.stringify(delays.flow)}`);
    for (const [c, v] of Object.entries(delays.categories)) {
      console.log(
        `  ${c} : ${v.jobs} travaux ; outbox p50/p95 ${v.dispatch.p50S}/${v.dispatch.p95S} s ; centre ${v.center.p50S}/${v.center.p95S} s ; retard push ${v.pushLate.p50S}/${v.pushLate.p95S} s (n=${v.pushLate.n})`,
      );
    }
  }
  const integrity = read(path.join(full, 'integrity.json'));
  if (integrity) {
    const bad = Object.entries(integrity.checks)
      .filter(([, v]) => !v.ok)
      .map(([k]) => k);
    console.log(
      `intégrité : ${integrity.ok ? 'OK' : `ÉCHEC ${bad.join(', ')}`} ; vidange ${JSON.stringify(integrity.checks.drain)}`,
    );
  }
  const quiet = read(path.join(full, 'quiet-org.json'));
  if (quiet) {
    console.log(
      `entreprise peu active : ${quiet.received}/${quiet.sales} reçues, délai p50/p95/max ${quiet.delayS.p50}/${quiet.delayS.p95}/${quiet.delayS.max} s`,
    );
  }
  for (const f of fs
    .readdirSync(full)
    .filter((x) => x.endsWith('.unexpected.jsonl'))) {
    console.log(`inattendues : ${f}`);
    console.log(fs.readFileSync(path.join(full, f), 'utf8').trim());
  }
}
