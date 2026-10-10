#!/usr/bin/env node
/**
 * 1-20A — Synthèse d'un profil CPU (`.cpuprofile`) : temps propre par
 * fonction et par paquet, et temps inclusif des fonctions de l'application.
 *
 *   node api/test/load/profile-summary.js <fichier.cpuprofile> [--top=25]
 */
'use strict';

const fs = require('fs');

const file = process.argv[2];
const top = Number(
  (process.argv.find((a) => a.startsWith('--top=')) || '--top=25').slice(6),
);
const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes)
  for (const c of n.children || []) parent.set(c, n.id);

const self = new Map();
const dt = profile.timeDeltas;
profile.samples.forEach((id, i) =>
  self.set(id, (self.get(id) || 0) + (dt[i] || 0)),
);
const total = [...self.values()].reduce((a, b) => a + b, 0);

const pkg = (url) => {
  if (!url) return '(natif/V8)';
  const m =
    /node_modules[\/]\.pnpm[\/]([^\/]+)/.exec(url) ||
    /node_modules[\/](@[^\/]+[\/][^\/]+|[^\/]+)/.exec(url);
  if (m) return m[1].replace(/@[\d.]+.*$/, '').replace(/\+/g, '/');
  if (/[\/]api[\/]dist[\/]/.test(url))
    return `app:${url.split(/[\/]dist[\/]/)[1]}`;
  if (url.startsWith('node:')) return url;
  return url.split(/[\/]/).slice(-2).join('/');
};
const label = (n) =>
  `${n.callFrame.functionName || '(anonyme)'} ${pkg(n.callFrame.url)}:${n.callFrame.lineNumber + 1}`;

const byFn = new Map();
const byPkg = new Map();
const inclusiveApp = new Map();
for (const [id, t] of self) {
  const n = nodes.get(id);
  byFn.set(label(n), (byFn.get(label(n)) || 0) + t);
  const p = pkg(n.callFrame.url);
  byPkg.set(
    p.startsWith('app:') ? 'application (dist)' : p,
    (byPkg.get(p.startsWith('app:') ? 'application (dist)' : p) || 0) + t,
  );
  // Temps inclusif : remonte la pile, compte chaque fonction app une fois.
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const c = nodes.get(cur);
    if (!/[\/]api[\/]dist[\/]/.test(c.callFrame.url || '')) continue;
    const k = `${c.callFrame.functionName || '(anonyme)'} ${pkg(c.callFrame.url)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    inclusiveApp.set(k, (inclusiveApp.get(k) || 0) + t);
  }
}
const pct = (t) => `${((t / total) * 100).toFixed(1).padStart(5)} %`;
const show = (title, map, n) => {
  console.log(`\n${title}`);
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .forEach(([k, t]) => console.log(`${pct(t)}  ${k}`));
};
console.log(
  `échantillons ${profile.samples.length}, durée ${(total / 1e6).toFixed(1)} s`,
);
show('Temps propre par paquet', byPkg, 15);
show('Temps propre par fonction', byFn, top);
show('Temps inclusif (fonctions de l’application)', inclusiveApp, top);
