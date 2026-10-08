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
 * - `GET /<bucket>/<clé>` : sert l'image, comme l'URL publique d'un vrai
 *   stockage (chargée par la balise `<img>` du shell) ;
 * - `GET /__stats` : compteurs et clés, pour les assertions de la campagne.
 *
 * Écoute 127.0.0.1 seulement, hôte exact exigé ; aucune donnée persistée.
 */
'use strict';

const http = require('http');

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
  const stats = { puts: 0, deletes: 0, gets: 0, misses: 0 };
  const allowedHosts = new Set([`${host}:${port}`, `localhost:${port}`]);

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
      res.end(JSON.stringify({ ...stats, keys: [...objects.keys()] }));
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
    req.on('end', () => {
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
