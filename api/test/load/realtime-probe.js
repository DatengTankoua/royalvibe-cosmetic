#!/usr/bin/env node
/**
 * 1-20A — Sonde temps réel Socket.IO (TEST, local uniquement).
 *
 * Le serveur utilise Socket.IO (Engine.IO + protocole Socket.IO) : un simple
 * WebSocket k6 ne reproduit pas ce client. La sonde utilise donc
 * `socket.io-client` (même version que les e2e, transport `websocket` comme
 * le web) et se mesure SÉPARÉMENT de k6.
 *
 *   node api/test/load/realtime-probe.js [--sockets-per-user=2]
 *     [--target=multi|concentrated] [--sales-per-s=2] [--duration=30]
 *     [--refetch] [--reconnect] [--out=<f.json>]
 *
 * Mesures :
 * - connexions ouvertes, durée d'établissement, échecs ;
 * - propagation `sale:created` : réception par CHAQUE socket de
 *   l'entreprise (complétude) et aucune réception hors entreprise (fuite) ;
 * - `notifications:changed` chez les gestionnaires après une vente (inclut
 *   l'intervalle volontaire du traitement de fond, 5 s) ;
 * - `--refetch` : comme le web, chaque socket relit `GET /products` après
 *   un événement de vente (regroupement 400 ms) : amplification mesurée ;
 * - `--reconnect` : redémarrage de l'API (contrôle local) puis délai de
 *   reconnexion de toutes les sockets (stratégie par défaut du client).
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
    socketsPerUser: 2,
    target: 'multi',
    salesPerS: 2,
    duration: 30,
    refetch: false,
    reconnect: false,
    out: null,
  };
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const k = m[1].replace(/-(.)/g, (_, c) => c.toUpperCase());
    o[k] =
      m[2] === undefined
        ? true
        : Number.isNaN(Number(m[2]))
          ? m[2]
          : Number(m[2]);
  }
  return o;
}

const q = (values, p) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return (
    Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10
  );
};
const stats = (v) => ({
  n: v.length,
  p50: q(v, 0.5),
  p95: q(v, 0.95),
  p99: q(v, 0.99),
  max: v.length ? Math.round(Math.max(...v) * 10) / 10 : null,
});
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const opts = parse();
  const state = L.requireRunningState();
  const url = L.assertLocalTarget(state.apiUrl);
  const { orgs, sessions } = L.readJson(L.SESSIONS_FILE);
  const orgKind = Object.fromEntries(orgs.map((o) => [o.key, o]));
  const chosen = sessions.filter(
    (s) =>
      opts.target !== 'concentrated' || orgKind[s.org].kind === 'concentrated',
  );

  // ── 1. Connexions ──────────────────────────────────────────────────────
  const sockets = [];
  const connectMs = [];
  let connectFailures = 0;
  const t0 = performance.now();
  await Promise.all(
    chosen.flatMap((s) =>
      Array.from(
        { length: opts.socketsPerUser },
        () =>
          new Promise((resolve) => {
            const started = performance.now();
            const socket = io(url, {
              transports: ['websocket'],
              auth: { token: s.token },
              // Comme un navigateur : l'origine web autorisée (contrôle
              // `allowRequest` du serveur inchangé).
              extraHeaders: { origin: L.WEB_ORIGIN },
              reconnection: true,
            });
            const entry = {
              socket,
              session: s,
              sales: new Map(),
              signals: [],
              connects: 0,
              refetchPending: false,
            };
            socket.on('connect', () => {
              entry.connects += 1;
              entry.lastConnectAt = performance.now();
              if (entry.connects === 1) {
                connectMs.push(performance.now() - started);
                resolve();
              }
            });
            socket.on('connect_error', () => {
              if (entry.connects === 0) {
                connectFailures += 1;
                resolve();
              }
            });
            socket.on('sale:created', (p) => {
              entry.sales.set(p._id, performance.now());
              if (opts.refetch) scheduleRefetch(entry);
            });
            socket.on('notifications:changed', () =>
              entry.signals.push(performance.now()),
            );
            sockets.push(entry);
          }),
      ),
    ),
  );
  const openAllMs = performance.now() - t0;

  // ── 2. Ventes et propagation ───────────────────────────────────────────
  const refetch = { requests: 0, ms: [], errors: 0 };
  function scheduleRefetch(entry) {
    if (entry.refetchPending) return;
    entry.refetchPending = true;
    setTimeout(async () => {
      entry.refetchPending = false;
      refetch.requests += 1;
      try {
        const r = await L.api('GET', '/products', {
          token: entry.session.token,
        });
        if (r.status === 200) refetch.ms.push(r.ms);
        else refetch.errors += 1;
      } catch {
        refetch.errors += 1;
      }
    }, 400);
  }

  const sellers = chosen.filter((s) => s.role === 'seller');
  const sent = [];
  const httpErrors = [];
  const interval = 1000 / opts.salesPerS;
  const end = performance.now() + opts.duration * 1000;
  let i = 0;
  const inflight = [];
  while (performance.now() < end) {
    const seller = sellers[i % sellers.length];
    const org = orgKind[seller.org];
    const productId = org.productIds[(i * 13) % org.productIds.length];
    i += 1;
    const tSend = performance.now();
    inflight.push(
      L.api('POST', '/sales', {
        token: seller.token,
        body: {
          productId,
          quantity: 1,
          salePrice: 1000,
          clientOperationId: crypto.randomUUID(),
        },
      }).then(
        (r) => {
          if (r.status === 201)
            sent.push({
              id: r.body._id,
              org: seller.org,
              tSend,
              tResp: tSend + r.ms,
              httpMs: r.ms,
            });
          else httpErrors.push(r.status);
        },
        () => httpErrors.push(0),
      ),
    );
    await delay(interval);
  }
  await Promise.all(inflight);
  // Laisse passer deux passes du traitement de fond (5 s) + marge.
  await delay(12_000);

  const propagation = [];
  let expected = 0;
  let received = 0;
  let leaks = 0;
  for (const sale of sent) {
    for (const entry of sockets) {
      const got = entry.sales.get(sale.id);
      if (entry.session.org === sale.org) {
        expected += 1;
        if (got !== undefined) {
          received += 1;
          propagation.push(got - sale.tSend);
        }
      } else if (got !== undefined) {
        leaks += 1;
      }
    }
  }
  // notifications:changed : premier signal de chaque gestionnaire après
  // chaque vente de son entreprise (vendeur ≠ gestionnaire).
  const signalDelay = [];
  for (const entry of sockets.filter((e) => e.session.role !== 'seller')) {
    for (const sale of sent.filter((s) => s.org === entry.session.org)) {
      const first = entry.signals.find((t) => t >= sale.tResp);
      if (first !== undefined) signalDelay.push(first - sale.tResp);
    }
  }

  const result = {
    at: new Date().toISOString(),
    options: opts,
    connections: {
      sessions: chosen.length,
      requested: chosen.length * opts.socketsPerUser,
      opened: connectMs.length,
      failures: connectFailures,
      connectMs: stats(connectMs),
      openAllMs: Math.round(openAllMs),
    },
    sales: {
      offeredPerS: opts.salesPerS,
      created: sent.length,
      httpErrors: httpErrors.length,
      httpStatuses: [...new Set(httpErrors)],
      httpMs: stats(sent.map((s) => s.httpMs)),
    },
    saleCreated: {
      expectedDeliveries: expected,
      received,
      completeness: expected
        ? Math.round((received / expected) * 10000) / 100
        : null,
      crossOrganizationDeliveries: leaks,
      propagationMs: stats(propagation),
    },
    notificationsChanged: {
      note: 'inclut l’intervalle volontaire du traitement de fond (5 s)',
      firstSignalAfterSaleMs: stats(signalDelay),
    },
    refetch: opts.refetch
      ? {
          requests: refetch.requests,
          errors: refetch.errors,
          productsListMs: stats(refetch.ms),
        }
      : null,
  };

  // ── 3. Reconnexion après redémarrage de l'API ──────────────────────────
  if (opts.reconnect) {
    const before = new Map(sockets.map((e) => [e, e.connects]));
    const tRestart = performance.now();
    const restart = await L.control('/restart-api', {});
    const deadline = performance.now() + 60_000;
    while (performance.now() < deadline) {
      if (sockets.every((e) => e.connects > before.get(e))) break;
      await delay(100);
    }
    const reconnectedAfter = sockets
      .filter((e) => e.connects > before.get(e))
      .map((e) => e.lastConnectAt - tRestart);
    result.reconnect = {
      apiRestartMs: restart.restartMs,
      sockets: sockets.length,
      reconnected: reconnectedAfter.length,
      sinceRestartStartMs: stats(reconnectedAfter),
    };
  }

  for (const e of sockets) e.socket.close();
  const text = JSON.stringify(result, null, 2);
  if (opts.out) fs.writeFileSync(opts.out, text);
  console.log(text);
}

main().catch((error) => {
  console.error(`Sonde interrompue : ${error && error.stack}`);
  process.exit(1);
});
