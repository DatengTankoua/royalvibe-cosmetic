#!/usr/bin/env node
/**
 * 1-20A — Intégrité métier sous concurrence (TEST, routes HTTP réelles).
 *
 *   node api/test/load/concurrency.js [--out=<f.json>]
 *
 * Entreprise concentrée (plusieurs vendeurs), produits « Contention » :
 * A. vendeurs simultanés sur le même produit : exactement `stock` ventes,
 *    refus propres (400 INSUFFICIENT_STOCK), jamais de stock négatif ;
 * B. annulations simultanées et doublées : restauration EXACTE du stock,
 *    une seule annulation par vente ;
 * C. rejeu : même `clientOperationId` en parallèle (une vente), clé
 *    réutilisée avec un autre contenu ou par un autre vendeur (409), et
 *    flux SANS clé (aucune déduplication : comportement historique) ;
 * D. adhésions concurrentes (comptes existants d'autres entreprises) et
 *    double acceptation de la même invitation ;
 * E. rafale de connexions depuis une même IP : 429 ATTENDUS.
 * Les vérifications de notifications et de vidange sont faites ensuite par
 * `integrity.js` (après la passe du traitement de fond).
 */
'use strict';

require('../recipe/preload.cjs');
const fs = require('fs');
const crypto = require('crypto');
const L = require('./load-common');

const out = (/^--out=(.*)$/.exec(
  process.argv.find((a) => a.startsWith('--out=')) || '',
) || [])[1];

const tally = (responses) =>
  responses.reduce((acc, r) => {
    const key = `${r.status}${r.body && r.body.code ? ` ${r.body.code}` : ''}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

async function product(token, id) {
  const r = await L.api('GET', `/products/${id}`, { token });
  if (r.status !== 200) throw new Error(`Lecture produit ${r.status}`);
  return r.body.product ?? r.body;
}

async function setStock(ownerToken, id, target) {
  const p = await product(ownerToken, id);
  const add = target - p.remainingQuantity;
  if (add < 0) throw new Error('stock initial supérieur à la cible');
  if (add > 0) {
    const r = await L.api('PATCH', `/products/${id}`, {
      token: ownerToken,
      body: { additionalStock: add },
    });
    if (r.status !== 200) throw new Error(`Réassort ${r.status}`);
  }
  return (await product(ownerToken, id)).remainingQuantity;
}

const sale = (token, productId, quantity, key) =>
  L.api('POST', '/sales', {
    token,
    body: {
      productId,
      quantity,
      salePrice: 1000,
      ...(key === null
        ? {}
        : { clientOperationId: key ?? crypto.randomUUID() }),
    },
  });

async function main() {
  L.requireRunningState();
  const { orgs, sessions } = L.readJson(L.SESSIONS_FILE);
  const conc = orgs.find((o) => o.kind === 'concentrated');
  const inOrg = (key, role) =>
    sessions.filter((s) => s.org === key && s.role === role);
  const owner = inOrg(conc.key, 'owner')[0];
  const sellers = inOrg(conc.key, 'seller');
  const [pA, pB, pC] = conc.contentionProductIds;
  const results = { at: new Date().toISOString() };

  // ── A. Même produit, vendeurs simultanés ───────────────────────────────
  {
    const stock = await setStock(owner.token, pA, 20);
    const requests = sellers.flatMap((s) =>
      [1, 2, 3].map(() => sale(s.token, pA, 1)),
    );
    const responses = await Promise.all(requests);
    const after = (await product(owner.token, pA)).remainingQuantity;
    const created = responses.filter((r) => r.status === 201).length;
    // Variante quantité 2 sur stock impair : refus propre du reliquat.
    const stock2 = await setStock(owner.token, pA, 5);
    const r2 = await Promise.all(
      sellers.slice(0, 10).map((s) => sale(s.token, pA, 2)),
    );
    const after2 = (await product(owner.token, pA)).remainingQuantity;
    results.A_sameProduct = {
      stockBefore: stock,
      requests: requests.length,
      statuses: tally(responses),
      created,
      stockAfter: after,
      ok:
        created === stock &&
        after === 0 &&
        responses.every((r) => [201, 400].includes(r.status)),
      quantity2: {
        stockBefore: stock2,
        statuses: tally(r2),
        stockAfter: after2,
        ok: r2.filter((r) => r.status === 201).length === 2 && after2 === 1,
      },
    };
  }

  // ── B. Annulations simultanées et doublées ─────────────────────────────
  {
    const before = await setStock(owner.token, pB, 30);
    const created = [];
    for (let i = 0; i < 10; i += 1) {
      const r = await sale(sellers[i % sellers.length].token, pB, 3);
      if (r.status === 201)
        created.push({ id: r.body._id, seller: sellers[i % sellers.length] });
    }
    const mid = (await product(owner.token, pB)).remainingQuantity;
    // Chaque vente annulée deux fois en parallèle (vendeur et propriétaire).
    const cancels = await Promise.all(
      created.flatMap((c) => [
        L.api('DELETE', `/sales/${c.id}`, { token: c.seller.token }),
        L.api('DELETE', `/sales/${c.id}`, { token: owner.token }),
      ]),
    );
    const after = (await product(owner.token, pB)).remainingQuantity;
    results.B_cancellation = {
      stockBefore: before,
      salesCreated: created.length,
      stockAfterSales: mid,
      cancelRequests: cancels.length,
      statuses: tally(cancels),
      stockAfterCancel: after,
      ok:
        created.length === 10 &&
        mid === before - 30 &&
        after === before &&
        cancels.filter((r) => r.status === 204).length === 10 &&
        cancels.filter((r) => r.status === 404).length === 10,
    };
  }

  // ── C. Rejeu et idempotence ────────────────────────────────────────────
  {
    const before = await setStock(owner.token, pC, 10);
    const key = crypto.randomUUID();
    const seller = sellers[0];
    const same = await Promise.all(
      Array.from({ length: 10 }, () => sale(seller.token, pC, 1, key)),
    );
    const ids = new Set(
      same.filter((r) => r.status === 201).map((r) => r.body._id),
    );
    const afterSame = (await product(owner.token, pC)).remainingQuantity;
    const reused = await sale(seller.token, pC, 2, key);
    const otherSeller = await sale(sellers[1].token, pC, 1, key);
    const afterConflicts = (await product(owner.token, pC)).remainingQuantity;
    const noKey = await Promise.all([
      sale(seller.token, pC, 1, null),
      sale(seller.token, pC, 1, null),
    ]);
    const afterNoKey = (await product(owner.token, pC)).remainingQuantity;
    results.C_replay = {
      stockBefore: before,
      sameKeyParallel: {
        requests: 10,
        statuses: tally(same),
        distinctSaleIds: ids.size,
        stockAfter: afterSame,
      },
      sameKeyOtherPayload: tally([reused]),
      sameKeyOtherSeller: tally([otherSeller]),
      stockAfterConflicts: afterConflicts,
      withoutKey: {
        statuses: tally(noKey),
        stockAfter: afterNoKey,
        note: 'sans clientOperationId : aucune déduplication (comportement documenté 1-11C.1)',
      },
      ok:
        ids.size === 1 &&
        same.every((r) => r.status === 201) &&
        afterSame === before - 1 &&
        reused.status === 409 &&
        otherSeller.status === 409 &&
        afterConflicts === afterSame &&
        afterNoKey === afterSame - 2,
    };
  }

  // ── D. Adhésions concurrentes (comptes existants) ──────────────────────
  {
    const target = orgs.find((o) => o.kind === 'standard');
    const targetOwner = inOrg(target.key, 'owner')[0];
    const others = orgs
      .filter((o) => o.key !== target.key && o.kind === 'standard')
      .slice(0, 3);
    const joiners = others.map((o) => inOrg(o.key, 'seller')[0]);
    const created = [];
    for (const j of joiners) {
      const r = await L.api('POST', '/organizations/invitations', {
        token: targetOwner.token,
        body: { email: j.email, role: 'seller' },
      });
      if (r.status !== 201) throw new Error(`Invitation ${r.status}`);
      created.push({
        joiner: j,
        token: new URL(r.body.invitationUrl).searchParams.get('token'),
      });
    }
    // Chaque invitation acceptée deux fois en parallèle (deux onglets).
    const accepts = await Promise.all(
      created.flatMap((c) =>
        [1, 2].map(() =>
          L.api('POST', '/auth/invitations/accept', {
            token: c.joiner.token,
            body: { token: c.token, consent: true },
          }),
        ),
      ),
    );
    results.D_membership = {
      targetOrg: target.key,
      invitations: created.length,
      acceptRequests: accepts.length,
      statuses: tally(accepts),
      joiners: joiners.map((j) => j.userId),
      ok:
        accepts.filter((r) => r.status === 200 || r.status === 201).length ===
        created.length,
    };
    fs.writeFileSync(
      `${L.STATE_DIR}/membership-check.json`,
      JSON.stringify({
        organizationId: target.organizationId,
        joiners: joiners.map((j) => j.userId),
      }),
    );
  }

  // ── E. 429 attendus (connexion, même IP) ───────────────────────────────
  {
    const user = sessions.find((s) => s.role === 'seller');
    const burst = await Promise.all(
      Array.from({ length: 15 }, () =>
        L.api('POST', '/auth/login', {
          body: { email: user.email, password: L.PASSWORD },
        }),
      ),
    );
    results.E_expected429 = {
      requests: 15,
      statuses: tally(burst),
      note: 'POST /auth/login : 10 par minute et par IP (0B.6) ; 429 attendus',
      ok:
        burst.every((r) => [200, 201, 429].includes(r.status)) &&
        burst.some((r) => r.status === 429),
    };
  }

  results.ok = Object.values(results)
    .filter((v) => v && typeof v === 'object')
    .every((v) => v.ok !== false && (!v.quantity2 || v.quantity2.ok));
  const text = JSON.stringify(results, null, 2);
  if (out) fs.writeFileSync(out, text);
  console.log(text);
}

main().catch((error) => {
  console.error(`Concurrence interrompue : ${error && error.stack}`);
  process.exit(1);
});
