/* eslint-disable */
// 1-14D.2E — FIXTURE DE TEST (harnais proxy uniquement, jamais dans l'image).
//
// Monté dans le conteneur API par docker-compose.proxy-test.yml. Enregistre,
// pour chaque requête terminée, ce que l'API a RÉELLEMENT reçu et résolu :
// `req.ip` (Express, selon `trust proxy`), en-têtes de transfert reçus,
// protocole et hôte résolus. Puis lance le bootstrap RÉEL (`dist/main`).
// Aucune route ajoutée ; écriture dans un fichier du volume de test.
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = '/observe/requests.jsonl';
const expressPath = require.resolve('express', {
  paths: [path.dirname(require.resolve('@nestjs/platform-express', { paths: ['/app/api'] }))],
});
const express = require(expressPath);
const originalHandle = express.application.handle;

express.application.handle = function handle(req, res, callback) {
  res.on('finish', () => {
    const record = {
      url: req.originalUrl,
      status: res.statusCode,
      socket: req.socket && req.socket.remoteAddress,
      ip: req.ip,
      protocol: req.protocol,
      hostname: req.hostname,
      xForwardedFor: req.headers['x-forwarded-for'] ?? null,
      xRealIp: req.headers['x-real-ip'] ?? null,
      xForwardedProto: req.headers['x-forwarded-proto'] ?? null,
      xForwardedHost: req.headers['x-forwarded-host'] ?? null,
      forwarded: req.headers['forwarded'] ?? null,
      trustProxy: String(req.app.get('trust proxy')),
    };
    fs.appendFileSync(OUT, JSON.stringify(record) + '\n');
  });
  return originalHandle.call(this, req, res, callback);
};

require('/app/api/dist/main.js');
