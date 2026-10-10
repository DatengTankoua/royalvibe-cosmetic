#!/usr/bin/env node
/**
 * 1-20B — Témoin de l'ancien dispatcher pour les comparaisons de charge.
 *
 *   node api/test/load/make-baseline-dist.js [--ref=HEAD]
 *     [--files=src/push/push-dispatcher.service.ts,…]
 *     [--out=api/.load-dist-1-20a-baseline]
 *
 * Copie `api/dist` (construit par `pnpm --filter api build`) puis remplace
 * chaque fichier de `--files` (défaut : le dispatcher, 1-20B ; 1-20C :
 * `src/s3/s3.service.ts`) par sa version de `--ref`, transpilée avec les
 * options de `tsconfig.build.json`. Tout le reste du binaire est identique.
 * Le dossier produit est temporaire (supprimer après la campagne).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const API = path.resolve(__dirname, '../..');
const arg = (n, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  return m ? m.slice(n.length + 3) : d;
};
const ref = arg('ref', 'HEAD');
const out = path.resolve(
  arg('out', path.join(API, '.load-dist-1-20a-baseline')),
);
if (!out.startsWith(API + path.sep))
  throw new Error('--out doit être sous api/.');
if (!fs.existsSync(path.join(API, 'dist', 'main.js')))
  throw new Error('api/dist absent : pnpm --filter api build');

const files = arg('files', 'src/push/push-dispatcher.service.ts')
  .split(',')
  .filter(Boolean);
const ts = require(require.resolve('typescript', { paths: [API] }));
const config = ts.getParsedCommandLineOfConfigFile(
  path.join(API, 'tsconfig.build.json'),
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(String(d.messageText));
    },
  },
);
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(API, 'dist'), out, { recursive: true });
for (const file of files) {
  if (!/^src\/[\w/.-]+\.ts$/.test(file))
    throw new Error(`fichier refusé : ${file}`);
  const source = execFileSync('git', ['show', `${ref}:api/${file}`], {
    cwd: API,
    encoding: 'utf8',
  });
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      ...config.options,
      sourceMap: false,
      declaration: false,
    },
    fileName: path.basename(file),
  });
  const target = path.join(
    out,
    file.slice('src/'.length).replace(/\.ts$/, '.js'),
  );
  fs.writeFileSync(target, outputText);
  console.log(`remplacé : ${path.relative(API, target)} (${ref})`);
}
console.log(`témoin ${ref} : ${path.relative(API, out)}`);
