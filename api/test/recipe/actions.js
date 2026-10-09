/**
 * 1-14D.2H — Actions de recette partagées par `recipe.js` et `scenarios.js`
 * (TEST) : comptes par les routes publiques, webhook signé avec la clé
 * FICTIVE, exécution des deux CLI de rapprochement.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const C = require('./recipe-common');

function verificationTokenFor(email) {
  const lines = fs.existsSync(C.MAIL_FILE)
    ? fs.readFileSync(C.MAIL_FILE, 'utf8').split('\n').filter(Boolean)
    : [];
  const mail = lines
    .map((line) => JSON.parse(line))
    .filter((m) => m.to === email)
    .pop();
  const match =
    mail && /\/auth\/verify-email\?token=([^\s"&]+)/.exec(mail.text);
  if (!match) throw new Error(`Aucun e-mail de vérification pour ${email}`);
  return decodeURIComponent(match[1]);
}

/**
 * 1-16C.2 — Acceptation telle que l'envoie le web (case cochée) : versions
 * COURANTES lues dans le manifeste compilé (`api/dist/legal/archive`).
 */
const LEGAL_REQUIREMENTS = {
  owner_registration: {
    documents: ['conditions-utilisation', 'conditions-abonnement'],
    notices: ['confidentialite'],
  },
  invitation_account: {
    documents: ['conditions-utilisation'],
    notices: ['confidentialite'],
  },
};

function legalAcceptance(context) {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(C.DIST, 'legal', 'archive', 'manifest.json'),
      'utf8',
    ),
  );
  const refs = (ids) =>
    ids.map((id) => ({ id, version: manifest.documents[id].current }));
  const r = LEGAL_REQUIREMENTS[context];
  return {
    accepted: true,
    locale: 'fr',
    documents: refs(r.documents),
    notices: refs(r.notices),
  };
}

let sequence = 0;
const uniqueEmail = (label) => {
  sequence += 1;
  return `${label}-${Date.now().toString(36)}${sequence}@recette.local`.toLowerCase();
};

/** Inscription + vérification + connexion, par les routes publiques de l'API. */
async function registerOwner(label) {
  const email = uniqueEmail(label);
  const registered = await C.api('POST', '/auth/register', {
    body: {
      name: `Owner ${label}`.slice(0, 20),
      email,
      password: C.PASSWORD,
      organizationName: `Shop ${label}`.slice(0, 20),
      legalAcceptance: legalAcceptance('owner_registration'),
    },
  });
  if (registered.status !== 201)
    throw new Error(
      `inscription : HTTP ${registered.status} ${registered.text}`,
    );
  const confirmed = await C.api('POST', '/auth/email-verification/confirm', {
    body: { token: verificationTokenFor(email) },
  });
  if (confirmed.status !== 200)
    throw new Error(`vérification : HTTP ${confirmed.status}`);
  const login = await C.api('POST', '/auth/login', {
    body: { email, password: C.PASSWORD },
  });
  return {
    email,
    userId: String(registered.body.user._id),
    orgId: String(registered.body.organization._id),
    token: login.body && login.body.access_token,
  };
}

async function inviteMember(ownerToken, role, label) {
  const email = uniqueEmail(label);
  const invitation = await C.api('POST', '/organizations/invitations', {
    token: ownerToken,
    body: { email, role },
  });
  if (invitation.status !== 201)
    throw new Error(
      `invitation : HTTP ${invitation.status} ${invitation.text}`,
    );
  const token = new URL(invitation.body.invitationUrl).searchParams.get(
    'token',
  );
  await createInvitedAccount(token, email, label.slice(0, 20));
  const login = await C.api('POST', '/auth/login', {
    body: { email, password: C.PASSWORD },
  });
  const me = await C.api('GET', '/auth/me', {
    token: login.body && login.body.access_token,
  });
  if (me.status !== 200) throw new Error(`identité : HTTP ${me.status}`);
  return { email, userId: String(me.body._id) };
}

/** Dernier lien de création de compte reçu à une adresse (fichier d'envoi). */
function accountTokenFor(email) {
  const lines = fs.existsSync(C.MAIL_FILE)
    ? fs.readFileSync(C.MAIL_FILE, 'utf8').split('\n').filter(Boolean)
    : [];
  const mail = lines
    .map((line) => JSON.parse(line))
    .filter((m) => m.to === email)
    .pop();
  const match =
    mail &&
    /\/auth\/invitations\/create-account\?token=([^\s"&]+)/.exec(mail.text);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * 1-18B — Nouveau compte invité, comme le web : demande du lien (envoyé à
 * l'adresse invitée, jamais au créateur), lecture de l'e-mail, création.
 * Compte créé vérifié : aucune confirmation séparée.
 */
async function createInvitedAccount(invitationToken, email, name) {
  const link = await C.api('POST', '/auth/invitations/account-link', {
    body: { token: invitationToken },
  });
  if (link.status !== 202)
    throw new Error(`lien de création : HTTP ${link.status} ${link.text}`);
  let token = null;
  for (let i = 0; i < 100 && !token; i++) {
    token = accountTokenFor(email);
    if (!token) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!token) throw new Error(`Aucun lien de création pour ${email}`);
  const created = await C.api('POST', '/auth/invitations/create-account', {
    body: {
      token,
      name,
      password: C.PASSWORD,
      legalAcceptance: legalAcceptance('invitation_account'),
    },
  });
  if (created.status !== 200)
    throw new Error(`création : HTTP ${created.status} ${created.text}`);
  return created.body;
}

// ─── Webhook ─────────────────────────────────────────────────────────────────

const WRONG_FAKE_KEY = 'recipe-14d2h-WRONG-fictitious-webhook-key';

function signNotification(key) {
  const { JwtService } = C.apiRequire('@nestjs/jwt');
  const now = Math.floor(Date.now() / 1000);
  return new JwtService().sign(
    { iat: now, nbf: now, exp: now + 3600 },
    {
      secret: key,
      algorithm: 'HS256',
      header: { alg: 'HS256', typ: 'JWT', app: 'Recette' },
    },
  );
}

/** Notification POST de forme officielle (D.2F § 1.2), valeurs fictives. */
function buildNotification(
  payment,
  { status = 'SUCCESSFUL', wrongKey = false } = {},
) {
  if (payment.provider !== 'campay' || !payment.providerReference) {
    throw new Error(
      'Le webhook ne vise qu’un paiement CamPay portant une référence CamPay (mode campay).',
    );
  }
  return JSON.stringify({
    status,
    reference: payment.providerReference,
    amount: String(payment.amount),
    currency: 'XAF',
    operator: 'MTN',
    code: 'CP-RECIPE-0001',
    operator_reference: '0000000000',
    signature: signNotification(wrongKey ? WRONG_FAKE_KEY : C.FAKE.webhookKey),
    endpoint: 'collect',
    external_reference: payment.merchantReference,
    external_user: '',
    phone_number: '237600000000',
    description: 'Abonnement Stock Master',
    reason: '',
  });
}

async function postNotification(text) {
  const response = await C.api('POST', '/payments/webhooks/campay', {
    body: text,
  });
  return {
    status: response.status,
    body: response.body,
    cacheControl: response.headers.get('cache-control'),
    retryAfter: response.headers.get('retry-after'),
  };
}

// ─── CLI de rapprochement ────────────────────────────────────────────────────

const CLI = Object.freeze({
  simulated: path.join(__dirname, 'reconcile-sim.js'),
  real: path.join(C.DIST, 'migrations', 'reconcile-subscription-payment.js'),
});

/**
 * Exécute un CLI (simulé ou réel) sur la base de la recette ; JSON analysé.
 * Asynchrone : la boucle d'événements de l'appelant reste active.
 */
function runReconciliation(kind, uri, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI[kind], ...args], {
      cwd: C.WORK_DIR,
      env: C.apiEnv(uri),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        // sortie non JSON (erreur d'arguments)
      }
      resolve({ code, json, stdout, stderr });
    });
  });
}

module.exports = {
  legalAcceptance,
  verificationTokenFor,
  registerOwner,
  inviteMember,
  createInvitedAccount,
  buildNotification,
  postNotification,
  runReconciliation,
  CLI,
};
