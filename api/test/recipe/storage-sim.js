/**
 * 1-15C — Stockage objet SIMULÉ de la recette (TEST UNIQUEMENT).
 *
 * Remplace le stockage réel par un serveur local en mémoire, désigné à
 * l'API par `S3_ENDPOINT` (environnement construit de la recette). L'API
 * garde son code de production : vrai `S3Service`, vrai client AWS,
 * validations complètes du logo (taille, format, signature, dimensions,
 * décodage) AVANT tout envoi. Seule la destination des envois change.
 *
 * - `PUT /<bucket>/<clé>` : stocke le corps (décodage `aws-chunked` du SDK) ;
 * - `DELETE /<bucket>/<clé>` : supprime ;
 * - `GET /<bucket>/<clé>` : bucket PRIVÉ (R2) — servi SEULEMENT avec une
 *   URL signée valide : signature SigV4 recalculée avec le présigneur du SDK
 *   et les identifiants FICTIFS de la recette, et date d'expiration non
 *   dépassée ; sinon 403 (comme un bucket R2 privé). Vérification SIMULÉE :
 *   elle ne prouve rien du service R2 réel ;
 * - `GET /__stats` : compteurs et clés, pour les assertions de la campagne.
 *
 * Écoute 127.0.0.1 seulement, hôte exact exigé ; aucune donnée persistée.
 */
'use strict';

const http = require('http');

/** `20261008T101500Z` → Date (UTC), sinon `null`. */
function parseAmzDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value || '');
  if (!m) return null;
  return new Date(
    Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]),
  );
}

/**
 * Vérificateur d'URL signée : mêmes identifiants FICTIFS, région et
 * adressage que l'API de la recette (`recipe-common.apiEnv`). Comme un vrai
 * S3, la signature est vérifiée pour l'en-tête `Host` REÇU (un relais qui
 * changerait l'hôte, le chemin ou la requête invalide la signature).
 */
function createSignatureVerifier({ bucket }) {
  const C = require('./recipe-common');
  const { S3Client, GetObjectCommand } = C.apiRequire('@aws-sdk/client-s3');
  const { getSignedUrl } = C.apiRequire('@aws-sdk/s3-request-presigner');
  const clients = new Map();
  const clientFor = (hostHeader) => {
    if (!clients.has(hostHeader)) {
      clients.set(
        hostHeader,
        new S3Client({
          endpoint: `http://${hostHeader}`,
          region: 'us-east-1',
          forcePathStyle: true,
          credentials: {
            accessKeyId: 'recipe-fictitious',
            secretAccessKey: 'recipe-fictitious',
          },
        }),
      );
    }
    return clients.get(hostHeader);
  };
  return async (key, url, hostHeader) => {
    const client = clientFor(hostHeader);
    const signature = url.searchParams.get('X-Amz-Signature');
    const signedAt = parseAmzDate(url.searchParams.get('X-Amz-Date'));
    const expires = Number(url.searchParams.get('X-Amz-Expires'));
    if (!signature || !signedAt || !Number.isInteger(expires)) {
      return 'unsigned';
    }
    if (Date.now() > signedAt.getTime() + expires * 1000) return 'expired';
    const expected = new URL(
      await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: expires, signingDate: signedAt },
      ),
    ).searchParams.get('X-Amz-Signature');
    return expected === signature ? 'valid' : 'invalid';
  };
}

/** Corps `aws-chunked` (`<taille hex>[;...]\r\n<données>\r\n ... 0\r\n<trailers>`). */
function decodeAwsChunked(buffer) {
  const parts = [];
  let offset = 0;
  for (;;) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const size = parseInt(
      buffer.subarray(offset, lineEnd).toString('latin1').split(';')[0],
      16,
    );
    if (!Number.isFinite(size) || size === 0) break;
    const start = lineEnd + 2;
    parts.push(buffer.subarray(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(parts);
}

function startStorageSimulator({ host, port, bucket }) {
  const objects = new Map();
  const stats = { puts: 0, deletes: 0, gets: 0, misses: 0, denied: 0 };
  const denials = { unsigned: 0, expired: 0, invalid: 0 };
  const verify = createSignatureVerifier({ bucket });
  // Hôtes publics supplémentaires (relais type nginx de la recette :
  // `RECIPE_STORAGE_EXTRA_HOSTS=localhost:4296`).
  const allowedHosts = new Set([
    `${host}:${port}`,
    `localhost:${port}`,
    ...String(process.env.RECIPE_STORAGE_EXTRA_HOSTS || '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  ]);

  const server = http.createServer((req, res) => {
    if (!allowedHosts.has(req.headers.host)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url, `http://${host}:${port}`);
    if (req.method === 'GET' && url.pathname === '/__stats') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(
        JSON.stringify({ ...stats, denials, keys: [...objects.keys()] }),
      );
      return;
    }
    const prefix = `/${bucket}/`;
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404).end();
      return;
    }
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      if (req.method === 'PUT') {
        const chunked =
          String(req.headers['content-encoding'] || '').includes(
            'aws-chunked',
          ) || req.headers['x-amz-decoded-content-length'] !== undefined;
        const body = chunked ? decodeAwsChunked(raw) : raw;
        objects.set(key, {
          body,
          contentType:
            req.headers['content-type'] || 'application/octet-stream',
        });
        stats.puts += 1;
        res.writeHead(200, { etag: `"${stats.puts}"` }).end();
        return;
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        stats.deletes += 1;
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        // Bucket privé : jamais de lecture sans URL signée valide.
        const verdict = await verify(key, url, req.headers.host).catch(
          () => 'invalid',
        );
        if (verdict !== 'valid') {
          stats.denied += 1;
          denials[verdict] += 1;
          res.writeHead(403, { 'cache-control': 'no-store' }).end();
          return;
        }
        const object = objects.get(key);
        if (!object) {
          stats.misses += 1;
          res.writeHead(404).end();
          return;
        }
        stats.gets += 1;
        res.writeHead(200, {
          'content-type': object.contentType,
          'content-length': object.body.length,
          'cache-control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : object.body);
        return;
      }
      res.writeHead(405).end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { startStorageSimulator, decodeAwsChunked };
