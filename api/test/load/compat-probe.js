#!/usr/bin/env node
/**
 * 1-20F — Compatibilité « nouveau web / API en service » (stack de charge
 * locale) : la requête paginée du web 1-20F (`GET /products?sectionId=…&
 * limit=24&q=…`) et l'ancien contrat (`GET /products?sectionId=…`) pour un
 * même rayon. Sur une API antérieure, la réponse paginée doit être le
 * TABLEAU complet (le web le présente comme complet, recherche appliquée
 * localement) ; sur l'API 1-20F, une page `{ items, total, … }`.
 *
 *   node api/test/load/compat-probe.js [--out=<f.json>]
 */
'use strict';

require('../recipe/preload.cjs');
const fs = require('fs');
const L = require('./load-common');

async function get(token, path) {
  const res = await fetch(`${L.API_URL}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function main() {
  L.requireRunningState();
  const { orgs, sessions } = L.readJson(L.SESSIONS_FILE);
  const org = orgs.find((o) => o.key.startsWith('conc')) || orgs[0];
  const owner = sessions.find((s) => s.org === org.key && s.role === 'owner');
  const sectionId = org.sectionIds[0];
  const legacy = await get(owner.token, `/products?sectionId=${sectionId}`);
  const paged = await get(
    owner.token,
    `/products?sectionId=${sectionId}&limit=24&q=${encodeURIComponent('0')}`,
  );
  const out = {
    at: new Date().toISOString(),
    legacy: {
      status: legacy.status,
      isArray: Array.isArray(legacy.body),
      length: Array.isArray(legacy.body) ? legacy.body.length : null,
    },
    paged: {
      status: paged.status,
      isArray: Array.isArray(paged.body),
      length: Array.isArray(paged.body) ? paged.body.length : null,
      keys: Array.isArray(paged.body) ? null : Object.keys(paged.body).sort(),
    },
  };
  out.verdict = out.paged.isArray
    ? 'API antérieure : tableau complet (repli `legacy` du web, résultat complet)'
    : 'API 1-20F : contrat paginé';
  const text = JSON.stringify(out, null, 2);
  const arg = process.argv.find((a) => a.startsWith('--out='));
  if (arg) fs.writeFileSync(arg.slice(6), text);
  console.log(text);
}

main().catch((e) => {
  console.error(e && e.stack);
  process.exit(1);
});
