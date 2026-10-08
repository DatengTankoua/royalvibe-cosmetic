#!/usr/bin/env node
/* eslint-disable */
/**
 * Essai OPÉRATEUR du stockage privé R2 — à lancer à la main, jamais en CI.
 * Utilise le code LIVRÉ (`api/dist`) : validation des photos, envoi, URL
 * signée, suppression. Aucun `.env` n'est lu : les variables S3_* sont
 * fournies par le shell de l'opérateur. Aucun secret n'est affiché.
 *
 * Objets écrits UNIQUEMENT sous un préfixe d'organisation fictive
 * (`organizations/000000000000000000000000/products/`) et supprimés à la
 * fin. Aucune base MongoDB n'est contactée.
 *
 * Usage (depuis la racine du dépôt, après `pnpm --filter api build`) :
 *   S3_ENDPOINT=https://<ACCOUNT_ID>.<juridiction>.r2.cloudflarestorage.com \
 *   S3_REGION=auto S3_BUCKET=stockmaster-prod S3_FORCE_PATH_STYLE=false \
 *   S3_ACCESS_KEY=… S3_SECRET_KEY=… \
 *   node api/test/storage/r2-operator-trial.js --confirm-bucket=stockmaster-prod
 * Options : --skip-expiry (n'attend pas l'expiration, ~65 s) ;
 * S3_CHECKSUM_MODE=when_required pour comparer si l'envoi échoue.
 * Sortie 0 si tout passe, 1 sinon, 64 si les arguments sont invalides.
 */
'use strict';

const path = require('path');
const DIST = path.join(__dirname, '..', '..', 'dist');
const sharp = require(require.resolve('sharp', { paths: [path.join(__dirname, '..', '..')] }));

const TRIAL_PREFIX = 'organizations/000000000000000000000000/products';
const args = process.argv.slice(2);
const confirm = (args.find((a) => a.startsWith('--confirm-bucket=')) || '').split('=')[1];
const skipExpiry = args.includes('--skip-expiry');

function usage(message) {
  console.error(`${message}\nVoir l'en-tête de api/test/storage/r2-operator-trial.js.`);
  process.exit(64);
}

for (const name of ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY']) {
  if (!process.env[name]) usage(`Variable ${name} absente.`);
}
if (confirm !== process.env.S3_BUCKET) {
  usage(`--confirm-bucket doit reprendre exactement S3_BUCKET (${process.env.S3_BUCKET}).`);
}

const { S3Service } = require(path.join(DIST, 's3', 's3.service.js'));
const { validateProductImage } = require(path.join(DIST, 'products', 'product-image-validation.js'));

const config = (overrides = {}) => {
  const values = { ...process.env, ...overrides };
  return { get: (key) => values[key] };
};

const results = [];
function check(ok, label, detail = '') {
  results.push({ ok: Boolean(ok), label, detail });
  console.log(`${ok ? 'OK ' : 'KO '} ${label}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const s3 = new S3Service(config());
  const endpoint = new URL(process.env.S3_ENDPOINT);
  console.log(JSON.stringify({
    storage: s3.storage,
    endpointHost: endpoint.host,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    checksumMode: process.env.S3_CHECKSUM_MODE || 'when_supported (défaut)',
    signedUrlTtlSeconds: s3.signedUrlTtlSeconds,
  }, null, 2));

  const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#2a9d8f' } }).jpeg().toBuffer();
  const validated = await validateProductImage({ buffer: jpeg, size: jpeg.length, mimetype: 'image/jpeg' });
  check(validated.contentType === 'image/jpeg', 'photo contrôlée par le code livré');

  let ref;
  try {
    ref = await s3.uploadValidatedImage(jpeg, TRIAL_PREFIX, validated);
    check(true, 'envoi (PutObject) accepté par le stockage', ref.key);
  } catch (err) {
    check(false, 'envoi (PutObject)', `${err.name}: ${String(err.message).slice(0, 160)}`);
    console.log('Si l’erreur concerne une somme de contrôle, relancer avec S3_CHECKSUM_MODE=when_required.');
    return finish();
  }

  try {
    const signed = await s3.signedReadUrl(ref, TRIAL_PREFIX);
    check(Boolean(signed), 'URL GET signée produite');
    const res = await fetch(signed);
    const body = Buffer.from(await res.arrayBuffer());
    check(res.status === 200, 'lecture par URL signée', `HTTP ${res.status}`);
    check(res.headers.get('content-type') === 'image/jpeg', 'Content-Type stocké', res.headers.get('content-type') || '');
    check(Buffer.compare(body, jpeg) === 0, 'octets identiques');

    const unsigned = new URL(signed);
    unsigned.search = '';
    const plain = await fetch(unsigned.href);
    check(plain.status === 400 || plain.status === 403, 'même objet sans signature refusé (bucket privé)', `HTTP ${plain.status}`);

    const forged = new URL(signed);
    forged.pathname = forged.pathname.replace('000000000000000000000000', '111111111111111111111111');
    const tampered = await fetch(forged.href);
    check(tampered.status === 403, 'clé modifiée dans un lien signé refusée', `HTTP ${tampered.status}`);

    if (!skipExpiry) {
      const short = new S3Service(config({ S3_SIGNED_URL_TTL_SECONDS: '60' }));
      const expiring = await short.signedReadUrl(ref, TRIAL_PREFIX);
      console.log('… attente de l’expiration (65 s)');
      await sleep(65_000);
      const expired = await fetch(expiring);
      check(expired.status === 403, 'lien expiré refusé', `HTTP ${expired.status}`);
    }
  } finally {
    const outcome = await s3.deleteStoredObject(ref, TRIAL_PREFIX);
    check(outcome === 'deleted', 'suppression (DeleteObject)', outcome);
    const after = await s3.signedReadUrl(ref, TRIAL_PREFIX);
    const gone = await fetch(after);
    check(gone.status === 404, 'objet absent après suppression', `HTTP ${gone.status}`);
  }
  finish();
})().catch((err) => {
  check(false, 'erreur inattendue', `${err.name}: ${String(err.message).slice(0, 160)}`);
  finish();
});

function finish() {
  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ passed: results.length - failed, total: results.length }));
  process.exit(failed === 0 ? 0 : 1);
}
