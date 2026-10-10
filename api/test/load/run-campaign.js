#!/usr/bin/env node
/**
 * 1-20A — Pilote de la progression par paliers (k6 + mesures système).
 *
 *   node api/test/load/run-campaign.js --k6=<k6.exe> --out=<dossier> \
 *     --label=catalog-ramp --scenario=catalog [--target=multi] \
 *     --levels=5,10,25,50 --duration=45 [--pace=1] [--think] [--no-stop]
 *
 * Un `k6 run` par palier (synthèse propre à chaque palier), phase marquée
 * pour les échantillonneurs, puis agrégation sur la fenêtre du palier :
 * k6 (débit, latences par route, erreurs), API (CPU, mémoire, retard de
 * boucle, pool MongoDB, sockets), MongoDB (latences, transactions,
 * connexions), travaux de notification, processus (API, mongod, k6) et
 * mémoire libre.
 *
 * Critères d'arrêt FIXÉS AVANT EXÉCUTION (`STOP`) : le premier palier qui
 * en franchit un arrête la progression (sauf `--no-stop`).
 */
'use strict';

require('../recipe/preload.cjs');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const L = require('./load-common');

/** Critères d'arrêt (fixés avant toute mesure). */
const STOP = Object.freeze({
  unexpectedErrorRate: 0.01, // > 1 % de réponses inattendues
  routeP95Ms: 1500, // p95 d'une route (n ≥ 20)
  routeP99Ms: 3000, // p99 d'une route (n ≥ 20)
  minRouteSamples: 20,
  achievedOfferedRatio: 0.9, // débit obtenu < 90 % du débit offert
  heapRatio: 0.8, // tas API > 80 % de la borne
  hostFreeMbMin: 250, // mémoire libre de la machine
  eldP99MedianMs: 250, // retard de boucle (médiane des p99 par seconde)
  dbAvgLatencyMs: 50, // latence moyenne lecture ou écriture MongoDB
  poolWaitP99Ms: 200, // attente d'une connexion du pool
  generatorCores: 4, // k6 : au-delà, mesure suspecte (générateur saturé)
  // 1-20B : dérive de la file de notifications (plus ancien travail prêt).
  queueOldestAgeS: 120,
});

function args() {
  const o = { target: 'multi', pace: 1, think: false, stop: true };
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    if (m[1] === 'no-stop') o.stop = false;
    else o[m[1]] = m[2] === undefined ? true : m[2];
  }
  for (const k of ['k6', 'out', 'label', 'scenario', 'levels', 'duration'])
    if (!o[k]) throw new Error(`--${k} requis`);
  o.levels = String(o.levels).split(',').map(Number);
  o.duration = Number(o.duration);
  o.pace = Number(o.pace);
  return o;
}

function readJsonl(file, from, to) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((x) => x && x.t >= from && x.t <= to);
  } catch {
    return [];
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const vals = (rows, f) =>
  rows
    .map(f)
    .map(num)
    .filter((v) => v !== null);
const max = (a) => (a.length ? Math.max(...a) : null);
const min = (a) => (a.length ? Math.min(...a) : null);
const avg = (a) =>
  a.length
    ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100
    : null;
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const r1 = (v) =>
  v === null || v === undefined ? null : Math.round(v * 10) / 10;

function weighted(rows, key) {
  let ops = 0;
  let total = 0;
  for (const r of rows) {
    if (!r[key]) continue;
    ops += r[key].ops;
    total += r[key].ops * r[key].avgMs;
  }
  return { ops, avgMs: ops ? Math.round((total / ops) * 100) / 100 : 0 };
}

function runK6(o, vus, summaryPath) {
  const env = {
    ...process.env,
    SCENARIO: o.scenario,
    TARGET: o.target,
    VUS: String(vus),
    DURATION: `${o.duration}s`,
    PACE_S: String(o.pace),
    THINK: o.think ? '1' : '0',
    SESSIONS: L.SESSIONS_FILE,
    SUMMARY_OUT: summaryPath,
    BASE_URL: L.API_URL,
    K6_NO_USAGE_REPORT: 'true',
  };
  return new Promise((resolve, reject) => {
    const child = spawn(
      o.k6,
      [
        'run',
        '--quiet',
        '--no-color',
        // 1-20B : messages console bruts (lignes `UNEXPECTED {json}`).
        '--log-format=raw',
        path.join(__dirname, 'k6', 'stockmaster.js'),
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let text = '';
    let pendingLine = '';
    const unexpected = [];
    const collect = (d) => {
      text += d;
      // 1-20B : lignes `UNEXPECTED {json}` de k6 (console.warn).
      pendingLine += d;
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop();
      for (const line of lines) {
        const m = /UNEXPECTED (\{.*\})\s*$/.exec(line);
        if (!m) continue;
        try {
          unexpected.push(JSON.parse(m[1]));
        } catch {
          unexpected.push({ raw: line.slice(0, 400) });
        }
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('exit', (code) =>
      resolve({ code, text: text.slice(-4000), unexpected }),
    );
  });
}

function summarize(o, vus, summary, from, to) {
  const m = summary.metrics;
  const count = (k) => (m[k] ? m[k].values.count : 0);
  const routes = {};
  for (const [k, v] of Object.entries(m)) {
    const r = /^http_req_duration\{name:(.*)\}$/.exec(k);
    if (!r || !v.values.count) continue;
    routes[r[1]] = {
      n: v.values.count,
      p50: r1(v.values.med),
      p95: r1(v.values['p(95)']),
      p99: r1(v.values['p(99)']),
      max: r1(v.values.max),
    };
  }
  const seconds = (to - from) / 1000;
  const requests = count('http_reqs');
  const iterations = count('iterations');
  const api = readJsonl(L.METRICS_API, from, to);
  const db = readJsonl(L.METRICS_DB, from, to).filter((x) => !x.error);
  const proc = readJsonl(L.METRICS_PROC, from, to);
  const offered = o.think ? null : Math.round((vus / o.pace) * 100) / 100;
  const obtained = Math.round((iterations / o.duration) * 100) / 100;
  return {
    label: o.label,
    scenario: o.scenario,
    target: o.target,
    vus,
    durationS: o.duration,
    paceS: o.think ? null : o.pace,
    think: o.think,
    windowS: Math.round(seconds),
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    k6: {
      requests,
      reqPerS: Math.round((requests / o.duration) * 10) / 10,
      iterations,
      offeredIterPerS: offered,
      obtainedIterPerS: obtained,
      lateIterationsRate: m.iterations_late
        ? r1(m.iterations_late.values.rate * 100)
        : null,
      unexpectedErrors: count('unexpected_errors'),
      businessRefusals: count('business_refusals'),
      rateLimited: count('rate_limited'),
      timeouts: count('timeouts'),
      routes,
    },
    api: {
      cpuPctAvg: avg(vals(api, (x) => x.cpuPct)),
      cpuPctMax: max(vals(api, (x) => x.cpuPct)),
      rssMbMax: max(vals(api, (x) => x.rssMb)),
      heapUsedMbMax: max(vals(api, (x) => x.heapUsedMb)),
      eldP99MsMedian: median(vals(api, (x) => x.eldP99Ms)),
      eldMaxMs: max(vals(api, (x) => x.eldMaxMs)),
      socketsMax: max(vals(api, (x) => x.sockets)),
      poolMaxInUse: max(vals(api, (x) => x.poolMaxInUse)),
      poolWaitP99MsMax: max(vals(api, (x) => x.poolWaitP99Ms)),
      poolFailed: max(vals(api, (x) => x.poolFailed)),
      // 1-20C : signatures d'URL GET calculées sur la fenêtre.
      signatures: vals(api, (x) => x.signatures).reduce((a, b) => a + b, 0),
    },
    db: {
      connectionsMax: max(vals(db, (x) => x.connections)),
      reads: weighted(db, 'reads'),
      writes: weighted(db, 'writes'),
      txCommitted: vals(db, (x) => x.txCommitted).reduce((a, b) => a + b, 0),
      txAborted: vals(db, (x) => x.txAborted).reduce((a, b) => a + b, 0),
      cacheMbMax: max(vals(db, (x) => x.cacheMb)),
      pendingJobsMax: max(vals(db, (x) => x.pendingJobs)),
      oldestPendingJobAgeSMax: max(vals(db, (x) => x.oldestPendingJobAgeS)),
      dueDeliveriesMax: max(vals(db, (x) => x.dueDeliveries)),
      oldestDueDeliveryLateSMax: max(vals(db, (x) => x.oldestDueDeliveryLateS)),
    },
    proc: {
      apiCoresAvg: avg(vals(proc, (x) => x.api && x.api.cores)),
      apiCoresMax: max(vals(proc, (x) => x.api && x.api.cores)),
      mongodCoresAvg: avg(vals(proc, (x) => x.mongod && x.mongod.cores)),
      mongodCoresMax: max(vals(proc, (x) => x.mongod && x.mongod.cores)),
      mongodWsMbMax: max(vals(proc, (x) => x.mongod && x.mongod.wsMb)),
      k6CoresAvg: avg(vals(proc, (x) => x.k6 && x.k6.cores)),
      k6CoresMax: max(vals(proc, (x) => x.k6 && x.k6.cores)),
      k6WsMbMax: max(vals(proc, (x) => x.k6 && x.k6.wsMb)),
      hostFreeMbMin: min(vals(proc, (x) => x.freeMb)),
    },
  };
}

/** Critères franchis par un palier (liste vide = aucun). */
function verdict(s) {
  const reasons = [];
  const total = s.k6.requests || 1;
  if (s.k6.unexpectedErrors / total > STOP.unexpectedErrorRate)
    reasons.push(
      `erreurs inattendues ${((s.k6.unexpectedErrors / total) * 100).toFixed(2)} %`,
    );
  for (const [name, r] of Object.entries(s.k6.routes)) {
    if (r.n < STOP.minRouteSamples) continue;
    if (r.p95 > STOP.routeP95Ms) reasons.push(`p95 ${name} = ${r.p95} ms`);
    else if (r.p99 > STOP.routeP99Ms) reasons.push(`p99 ${name} = ${r.p99} ms`);
  }
  if (
    s.k6.offeredIterPerS &&
    s.k6.obtainedIterPerS / s.k6.offeredIterPerS < STOP.achievedOfferedRatio
  )
    reasons.push(
      `débit obtenu ${s.k6.obtainedIterPerS}/${s.k6.offeredIterPerS} it/s`,
    );
  if (s.api.heapUsedMbMax > STOP.heapRatio * L.LIMITS.apiHeapMb)
    reasons.push(`tas API ${s.api.heapUsedMbMax} Mo`);
  if (
    s.proc.hostFreeMbMin !== null &&
    s.proc.hostFreeMbMin < STOP.hostFreeMbMin
  )
    reasons.push(`mémoire libre ${s.proc.hostFreeMbMin} Mo`);
  if (s.api.eldP99MsMedian > STOP.eldP99MedianMs)
    reasons.push(`retard de boucle p99 médian ${s.api.eldP99MsMedian} ms`);
  if (Math.max(s.db.reads.avgMs, s.db.writes.avgMs) > STOP.dbAvgLatencyMs)
    reasons.push(
      `latence MongoDB ${Math.max(s.db.reads.avgMs, s.db.writes.avgMs)} ms`,
    );
  if (s.api.poolWaitP99MsMax > STOP.poolWaitP99Ms)
    reasons.push(`attente pool ${s.api.poolWaitP99MsMax} ms`);
  const warnings = [];
  if (s.db.oldestPendingJobAgeSMax > STOP.queueOldestAgeS)
    reasons.push(
      `file de notifications : plus ancien travail ${s.db.oldestPendingJobAgeSMax} s`,
    );
  if (s.proc.k6CoresMax !== null && s.proc.k6CoresMax > STOP.generatorCores)
    warnings.push(`générateur k6 ${s.proc.k6CoresMax} cœurs`);
  return { reasons, warnings };
}

async function main() {
  const o = args();
  L.requireRunningState();
  fs.mkdirSync(o.out, { recursive: true });
  const results = [];
  for (const vus of o.levels) {
    const phase = `${o.label}@${vus}`;
    fs.writeFileSync(L.PHASE_FILE, phase);
    const summaryPath = path.join(o.out, `${o.label}-${vus}vu.k6.json`);
    const from = Date.now();
    const run = await runK6(o, vus, summaryPath);
    const to = Date.now();
    fs.writeFileSync(L.PHASE_FILE, 'idle');
    if (!fs.existsSync(summaryPath)) {
      console.log(run.text);
      throw new Error(`k6 sans synthèse (code ${run.code})`);
    }
    const s = summarize(o, vus, L.readJson(summaryPath), from, to);
    s.verdict = verdict(s);
    s.k6.unexpectedLogged = run.unexpected.length;
    if (run.unexpected.length) {
      fs.writeFileSync(
        path.join(o.out, `${o.label}-${vus}vu.unexpected.jsonl`),
        run.unexpected.map((u) => JSON.stringify(u)).join('\n') + '\n',
      );
    }
    results.push(s);
    const top = Object.entries(s.k6.routes)
      .sort((a, b) => b[1].p95 - a[1].p95)
      .slice(0, 3)
      .map(([n, r]) => `${n} p95=${r.p95}`)
      .join(' ; ');
    console.log(
      `[${phase}] ${s.k6.reqPerS} req/s, it ${s.k6.obtainedIterPerS}/${s.k6.offeredIterPerS ?? '-'} ; err ${s.k6.unexpectedErrors} refus ${s.k6.businessRefusals} 429 ${s.k6.rateLimited} ; API ${s.proc.apiCoresAvg} cœurs, eld ${s.api.eldP99MsMedian} ms ; mongod ${s.proc.mongodCoresAvg} ; k6 ${s.proc.k6CoresAvg} ; ${top}${s.verdict.reasons.length ? ` ⇒ ARRÊT : ${s.verdict.reasons.join(', ')}` : ''}${s.verdict.warnings.length ? ` (! ${s.verdict.warnings.join(', ')})` : ''}`,
    );
    fs.writeFileSync(
      path.join(o.out, `${o.label}.json`),
      JSON.stringify({ stop: STOP, limits: L.LIMITS, results }, null, 2),
    );
    if (o.stop && s.verdict.reasons.length) {
      console.log(
        `[${o.label}] premier seuil atteint à ${vus} VU : progression arrêtée.`,
      );
      break;
    }
    // Courte pause : retour au repos entre paliers (vidange observable).
    await new Promise((r) => setTimeout(r, 5000));
  }
}

main().catch((error) => {
  fs.writeFileSync(L.PHASE_FILE, 'idle');
  console.error(`Campagne interrompue : ${error && error.stack}`);
  process.exit(1);
});
