/* eslint-disable */
// 1-14D.2E — Client de TEST exécuté dans un conteneur (adresse source réelle).
//
// Usage : node client.js '<json>' avec
//   { target: 'nginx' | 'direct', host, port, count, headers: [ {...}, ... ],
//     path?, mode?: 'login' | 'upgrade' }
// - nginx  : HTTPS vers nginx (certificat de test, SNI = host) ;
// - direct : HTTP direct vers l'API (sans nginx).
// Affiche sur stdout un JSON { statuses: [...], codes: [...] }.
'use strict';
const https = require('https');
const http = require('http');

const options = JSON.parse(process.argv[2]);
const API_HOST = 'api.royalvibe.tondomaine.com';

function send(headers) {
  const body = JSON.stringify({ email: 'nobody-14d2e@proxy.test', password: 'wrong-pw-1' });
  const isNginx = options.target === 'nginx';
  const upgrade = options.mode === 'upgrade';
  const lib = isNginx ? https : http;
  return new Promise((resolve) => {
    const req = lib.request(
      {
        host: options.host,
        port: options.port,
        method: upgrade ? 'GET' : 'POST',
        path: options.path ?? '/auth/login',
        servername: isNginx ? API_HOST : undefined,
        rejectUnauthorized: false,
        headers: {
          Host: isNginx ? API_HOST : 'api',
          ...(upgrade
            ? {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
              }
            : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }),
          ...headers,
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let code = null;
          try {
            code = JSON.parse(data).code ?? null;
          } catch {}
          resolve({ status: res.statusCode, code });
        });
      },
    );
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode, code: 'UPGRADED' });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, code: e.message }));
    if (!upgrade) req.write(body);
    req.end();
  });
}

(async () => {
  const statuses = [];
  const codes = [];
  for (let i = 0; i < options.count; i++) {
    const headers = options.headers[i % options.headers.length] || {};
    const r = await send(headers);
    statuses.push(r.status);
    codes.push(r.code);
  }
  process.stdout.write(JSON.stringify({ statuses, codes }));
})();
