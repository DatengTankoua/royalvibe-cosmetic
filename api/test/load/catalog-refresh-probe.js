#!/usr/bin/env node
/**
 * 1-20D — Relectures du catalogue après les ventes (TEST, local, Socket.IO).
 *
 *   node api/test/load/catalog-refresh-probe.js --mode=legacy|targeted
 *     [--clients=20] [--sales-per-s=2] [--duration=30] [--out=<f.json>]
 *
 * Chaque client = une session (socket `socket.io-client`, origine web
 * autorisée) affichant la page d'un rayon : le rayon 1 de son entreprise.
 * Les ventes (vendeurs, tour à tour) portent sur les produits de ces rayons :
 * chaque vente concerne donc tous les clients de l'entreprise (cas
 * défavorable). Comportement simulé, conforme au web (vérifié au
 * navigateur, rapport 1-20D) :
 * - `legacy` (web 1-20C) : signal `sale:*` d'un produit affiché → relecture
 *   COMPLÈTE du rayon (`GET /products?sectionId=`), regroupée 400 ms et
 *   sérialisée ; l'auteur relit en plus le rayon dès la confirmation de sa
 *   vente (`syncedVersion`, non regroupé) ;
 * - `targeted` (web 1-20D) : produits concernés relus ensemble
 *   (`GET /products?sectionId=&ids=`), même regroupement ; la confirmation
 *   de l'auteur rejoint le même regroupement.
 *
 * Mesures : lectures complètes et ciblées, octets reçus, latence HTTP des
 * ventes, délai entre la vente validée et la réponse qui fournit le stock à
 * jour à chaque lecteur, exactitude du stock final dans chaque client.
 */
'use strict';

require('../recipe/preload.cjs');
const fs = require('fs');
const crypto = require('crypto');
const L = require('./load-common');

const { R } = L;
const { io } = R.apiRequire('socket.io-client');

function parse() {
  const o = {
    mode: 'targeted',
    clients: 20,
    salesPerS: 2,
    duration: 30,
    out: null,
  };
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (!m) continue;
    const k = m[1].replace(/-(.)/g, (_, c) => c.toUpperCase());
    o[k] = Number.isNaN(Number(m[2])) ? m[2] : Number(m[2]);
  }
  if (!['legacy', 'targeted'].includes(o.mode)) throw new Error('--mode');
  return o;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (v, p) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
};
const stats = (v) => ({
  n: v.length,
  p50: q(v, 0.5),
  p95: q(v, 0.95),
  max: q(v, 1),
});

async function getJson(url, token) {
  const target = L.assertLocalTarget(`${L.API_URL}${url}`);
  const started = performance.now();
  const res = await fetch(target, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  return {
    status: res.status,
    bytes: Buffer.byteLength(text),
    ms: performance.now() - started,
    body: res.status === 200 ? JSON.parse(text) : null,
  };
}

/** Client simulé : état local du rayon affiché, relectures regroupées. */
function createClient(session, sectionId, mode, metrics) {
  const state = new Map(); // productId → remainingQuantity
  const pending = new Set();
  let full = false;
  let timer = null;
  let running = false;
  let dirty = false;
  const waiting = []; // { since, onFresh } : signal reçu, en attente de données
  const refresh = async () => {
    running = true;
    dirty = false;
    const ids = [...pending];
    const doFull = mode === 'legacy' || full || ids.length === 0;
    pending.clear();
    full = false;
    const startedAt = performance.now();
    const covered = waiting.filter((w) => w.since <= startedAt);
    const url = doFull
      ? `/products?sectionId=${sectionId}`
      : `/products?sectionId=${sectionId}&ids=${ids.join(',')}`;
    try {
      const r = await getJson(url, session.token);
      metrics[doFull ? 'full' : 'targeted'] += 1;
      metrics.bytes += r.bytes;
      if (r.status === 200) {
        for (const v of r.body)
          state.set(v.product._id, v.product.remainingQuantity);
        const doneAt = performance.now();
        for (const w of covered) {
          w.onFresh(doneAt);
          waiting.splice(waiting.indexOf(w), 1);
        }
      } else {
        metrics.errors += 1;
      }
    } catch {
      metrics.errors += 1;
    }
    running = false;
    if (dirty) request();
  };
  function request() {
    if (running) {
      dirty = true;
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, 400);
  }
  return {
    session,
    sectionId,
    state,
    async initialLoad() {
      const r = await getJson(
        `/products?sectionId=${sectionId}`,
        session.token,
      );
      for (const v of r.body)
        state.set(v.product._id, v.product.remainingQuantity);
    },
    onSaleSignal(productId, onFresh) {
      if (!state.has(productId)) return;
      waiting.push({ since: performance.now(), onFresh });
      pending.add(productId);
      request();
    },
    /** Auteur : confirmation de SA vente (HTTP 201). */
    onOwnSaleConfirmed(productId) {
      if (!state.has(productId)) return;
      if (mode === 'legacy') {
        // `syncedVersion` → relecture complète immédiate (non regroupée).
        void getJson(`/products?sectionId=${sectionId}`, session.token).then(
          (r) => {
            metrics.full += 1;
            metrics.bytes += r.bytes;
            if (r.status === 200)
              for (const v of r.body)
                state.set(v.product._id, v.product.remainingQuantity);
          },
        );
      } else {
        pending.add(productId);
        request();
      }
    },
    get idle() {
      return !running && !timer;
    },
  };
}

/** CPU, retard de boucle et mémoire de l'API sur la fenêtre des ventes. */
function systemWindow(from, to) {
  const rows = (file) => {
    try {
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((x) => x.t >= from && x.t <= to);
    } catch {
      return [];
    }
  };
  const api = rows(L.METRICS_API);
  const proc = rows(L.METRICS_PROC);
  const nums = (list, f) => list.map(f).filter((v) => typeof v === 'number');
  const avg = (v) =>
    v.length
      ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100
      : null;
  const median = (v) =>
    v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : null;
  return {
    cpuCoresAvg: avg(nums(proc, (x) => x.api && x.api.cores)),
    cpuPctAvg: avg(nums(api, (x) => x.cpuPct)),
    eldP99MsMedian: median(nums(api, (x) => x.eldP99Ms)),
    eldMaxMs: Math.max(0, ...nums(api, (x) => x.eldMaxMs)),
    rssMbMax: Math.max(0, ...nums(api, (x) => x.rssMb)),
    signatures: nums(api, (x) => x.signatures).reduce((a, b) => a + b, 0),
    hostFreeMbMin: Math.min(...nums(proc, (x) => x.freeMb), Infinity),
  };
}

async function main() {
  const o = parse();
  const state = L.requireRunningState();
  const url = L.assertLocalTarget(state.apiUrl);
  const { orgs, sessions } = L.readJson(L.SESSIONS_FILE);

  // Rayon affiché par entreprise : le premier, et ses produits.
  const owners = Object.fromEntries(
    sessions.filter((s) => s.role === 'owner').map((s) => [s.org, s]),
  );
  const viewed = {};
  for (const org of orgs) {
    const sectionId = org.sectionIds[0];
    const r = await getJson(
      `/products?sectionId=${sectionId}`,
      owners[org.key].token,
    );
    viewed[org.key] = {
      sectionId,
      productIds: r.body.map((v) => v.product._id),
    };
  }

  const metrics = { full: 0, targeted: 0, bytes: 0, errors: 0 };
  const clients = [];
  const sockets = [];
  for (let i = 0; i < o.clients; i += 1) {
    const s = sessions[i % sessions.length];
    clients.push(createClient(s, viewed[s.org].sectionId, o.mode, metrics));
  }
  // Préchauffage identique : chargement initial de chaque client (et du
  // cache de signatures 1-20C), hors mesures.
  await Promise.all(clients.map((c) => c.initialLoad()));

  const freshDelays = [];
  const saleTimes = new Map(); // saleId → instant de la réponse 201
  const pendingSignals = []; // signaux reçus avant la réponse de la vente
  await Promise.all(
    clients.map(
      (c) =>
        new Promise((resolve) => {
          const socket = io(url, {
            transports: ['websocket'],
            auth: { token: c.session.token },
            extraHeaders: { origin: L.WEB_ORIGIN },
          });
          socket.on('connect', resolve);
          socket.on('connect_error', resolve);
          const onSale = (p) => {
            if (!p || typeof p.productId !== 'string') return;
            c.onSaleSignal(p.productId, (doneAt) => {
              const at = saleTimes.get(p._id);
              if (at !== undefined) freshDelays.push(Math.max(0, doneAt - at));
              else pendingSignals.push({ saleId: p._id, doneAt });
            });
          };
          for (const e of ['sale:created', 'sale:updated', 'sale:deleted'])
            socket.on(e, onSale);
          sockets.push(socket);
        }),
    ),
  );
  const windowFrom = Date.now();
  const bytesBefore = metrics.bytes;
  const fullBefore = metrics.full;
  const targetedBefore = metrics.targeted;

  // Ventes : vendeurs des entreprises des clients, tour à tour.
  const orgKeys = [...new Set(clients.map((c) => c.session.org))];
  const sellers = sessions.filter(
    (s) => s.role === 'seller' && orgKeys.includes(s.org),
  );
  const authorClients = new Map(clients.map((c) => [c.session.userId, c]));
  const saleMs = [];
  const saleErrors = [];
  const end = performance.now() + o.duration * 1000;
  let i = 0;
  const inflight = [];
  while (performance.now() < end) {
    const seller = sellers[i % sellers.length];
    const products = viewed[seller.org].productIds;
    const productId = products[(i * 7) % products.length];
    i += 1;
    const t = performance.now();
    inflight.push(
      fetch(L.assertLocalTarget(`${L.API_URL}/sales`), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${seller.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          productId,
          quantity: 1,
          salePrice: 1000,
          clientOperationId: crypto.randomUUID(),
        }),
      })
        .then(async (res) => {
          const body = await res.json().catch(() => null);
          const doneAt = performance.now();
          saleMs.push(doneAt - t);
          if (res.status !== 201) {
            saleErrors.push(res.status);
            return;
          }
          saleTimes.set(body._id, doneAt);
          for (const s of pendingSignals.filter((x) => x.saleId === body._id)) {
            freshDelays.push(Math.max(0, s.doneAt - doneAt));
          }
          const author = authorClients.get(seller.userId);
          if (author) author.onOwnSaleConfirmed(productId);
        })
        .catch(() => saleErrors.push(0)),
    );
    await delay(1000 / o.salesPerS);
  }
  await Promise.all(inflight);
  const windowTo = Date.now();
  // Fin bornée : clients au repos (≤ 15 s), puis vérification du stock.
  const quietDeadline = performance.now() + 15_000;
  await delay(1000);
  while (performance.now() < quietDeadline && !clients.every((c) => c.idle)) {
    await delay(100);
  }
  await delay(500);
  let mismatches = 0;
  let checked = 0;
  for (const org of orgKeys) {
    const truth = await getJson(
      `/products?sectionId=${viewed[org].sectionId}`,
      owners[org].token,
    );
    const server = new Map(
      truth.body.map((v) => [v.product._id, v.product.remainingQuantity]),
    );
    for (const c of clients.filter((x) => x.session.org === org)) {
      for (const [id, qty] of server) {
        checked += 1;
        if (c.state.get(id) !== qty) mismatches += 1;
      }
    }
  }
  for (const s of sockets) s.close();

  const result = {
    at: new Date().toISOString(),
    options: { ...o, out: o.out ? 'fichier' : null },
    clients: clients.length,
    sales: {
      created: saleTimes.size,
      errors: saleErrors.length,
      // Refus métier attendus : produits « Contention » (stock 1) du rayon.
      statuses: [...new Set(saleErrors)],
      httpMs: stats(saleMs),
    },
    reads: {
      full: metrics.full - fullBefore,
      targeted: metrics.targeted - targetedBefore,
      errors: metrics.errors,
      bytes: metrics.bytes - bytesBefore,
      mbPerS:
        Math.round(
          ((metrics.bytes - bytesBefore) / 2 ** 20 / o.duration) * 100,
        ) / 100,
    },
    freshness: { saleToFreshStockMs: stats(freshDelays) },
    api: systemWindow(windowFrom, windowTo),
    finalStock: { checked, mismatches },
  };
  const text = JSON.stringify(result, null, 2);
  if (o.out) fs.writeFileSync(o.out, text);
  console.log(text);
}

main().catch((e) => {
  console.error(`Sonde interrompue : ${e && e.stack}`);
  process.exit(1);
});
