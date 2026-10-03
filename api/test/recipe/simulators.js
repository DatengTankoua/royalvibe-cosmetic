/**
 * 1-14D.2H — Simulateurs de la recette (TEST UNIQUEMENT), hébergés par le
 * serveur de contrôle du lanceur (127.0.0.1 uniquement).
 *
 * L'état vit dans le LANCEUR : il est partagé par l'API (quel que soit son
 * redémarrage) et par l'entrée de rapprochement simulé (autre processus).
 *
 * Deux faces sur le même registre de transactions :
 * - `/sim/provider/*` : prestataire SIMULÉ (contrat de
 *   `test/e2e/simulated-payment-provider.ts`, utilisé par les scénarios
 *   D.2C), appelé par l'adaptateur de test de `boot-api.js` ;
 * - `/campay/api/*` : faux serveur CamPay (formes officielles reprises de
 *   D.2D/D.2F : `/api/token/`, `/api/collect/`, `/api/transaction/{ref}/`),
 *   appelé par le VRAI adaptateur CamPay et son VRAI transport `fetch`, dont
 *   seule l'origine est redirigée vers cette boucle locale.
 *
 * Ce faux CamPay ne prouve RIEN du comportement réel de CamPay.
 * Le téléphone n'est jamais conservé (seule sa longueur l'est).
 */
'use strict';

const { randomUUID } = require('crypto');
const { FAKE } = require('./recipe-common');

const STATES = new Set(['pending', 'succeeded', 'failed']);
const CAMPAY_STATUS = {
  pending: 'PENDING',
  succeeded: 'SUCCESSFUL',
  failed: 'FAILED',
};
const INIT_BEHAVIORS = new Set([
  'accept',
  'reject',
  'unavailable',
  'lost',
  'uncertain-not-created',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class SimulationState {
  constructor() {
    this.reset();
  }

  reset() {
    this.transactions = new Map();
    this.initiations = [];
    this.statusCalls = 0;
    this.tokenCalls = 0;
    this.collectCalls = 0;
    this.initScript = [];
    this.statusScript = [];
    // Références uniques même après remise à zéro (index unique des
    // références prestataire en base) : horodatage + compteur, comme D.2C.
    this.sequence = this.sequence || 0;
  }

  queueInit(behaviors) {
    for (const behavior of behaviors) {
      if (!INIT_BEHAVIORS.has(behavior))
        throw new Error(`comportement d'initiation inconnu : ${behavior}`);
      this.initScript.push(behavior);
    }
  }

  queueStatus(behaviors) {
    for (const behavior of behaviors) {
      const valid =
        behavior === 'normal' ||
        behavior === 'unavailable' ||
        behavior === 'not-found' ||
        (behavior &&
          typeof behavior === 'object' &&
          behavior.override &&
          typeof behavior.override === 'object');
      if (!valid)
        throw new Error(
          `comportement de statut inconnu : ${JSON.stringify(behavior)}`,
        );
      this.statusScript.push(behavior);
    }
  }

  create(face, { merchantReference, amount, currency }) {
    this.sequence += 1;
    const tx = {
      face,
      providerReference:
        face === 'campay' ? randomUUID() : `SIM-${Date.now()}-${this.sequence}`,
      merchantReference,
      amount,
      currency,
      state: 'pending',
    };
    this.transactions.set(tx.providerReference, tx);
    return tx;
  }

  /** Référence marchand (affichée par l'interface) ou référence prestataire. */
  find(reference) {
    const direct =
      this.transactions.get(reference) ||
      this.transactions.get(String(reference).toLowerCase());
    if (direct) return direct;
    return [...this.transactions.values()].find(
      (t) => t.merchantReference === reference,
    );
  }

  settle(reference, state) {
    if (!STATES.has(state)) throw new Error(`état inconnu : ${state}`);
    const tx = this.find(reference);
    if (!tx) return null;
    tx.state = state;
    return tx;
  }

  nextStatusBehavior() {
    this.statusCalls += 1;
    return this.statusScript.shift() || 'normal';
  }

  stats() {
    return {
      initiations: this.initiations,
      collectCalls: this.collectCalls,
      tokenCalls: this.tokenCalls,
      statusCalls: this.statusCalls,
      pendingInitScript: [...this.initScript],
      pendingStatusScript: [...this.statusScript],
      transactions: [...this.transactions.values()].map((t) => ({ ...t })),
    };
  }
}

// ─── Prestataire simulé (contrat D.2C) ───────────────────────────────────────

function providerInitiate(sim, body) {
  sim.initiations.push({
    face: 'simulated',
    merchantReference: body.merchantReference,
    amount: body.amount,
    phoneLength: body.phoneLength,
  });
  const behavior = sim.initScript.shift() || 'accept';
  switch (behavior) {
    case 'reject':
      return { result: { outcome: 'rejected' } };
    case 'unavailable':
      return { error: 'unavailable' };
    case 'uncertain-not-created':
      return { error: 'uncertain' };
    case 'lost':
      sim.create('simulated', body);
      return { error: 'uncertain' };
    default:
      return {
        result: {
          outcome: 'accepted',
          providerReference: sim.create('simulated', body).providerReference,
        },
      };
  }
}

function statusOf(tx) {
  return {
    state: tx.state,
    providerReference: tx.providerReference,
    merchantReference: tx.merchantReference,
    amount: tx.amount,
    currency: tx.currency,
  };
}

function providerStatus(sim, { lookup }) {
  const behavior = sim.nextStatusBehavior();
  if (behavior === 'unavailable') return { error: 'unavailable' };
  if (behavior === 'not-found') return { status: null };
  const tx =
    lookup.by === 'provider'
      ? sim.transactions.get(lookup.providerReference)
      : [...sim.transactions.values()].find(
          (t) => t.merchantReference === lookup.merchantReference,
        );
  if (!tx) return { status: null };
  const status = statusOf(tx);
  return {
    status:
      typeof behavior === 'object'
        ? { ...status, ...behavior.override }
        : status,
  };
}

// ─── Faux CamPay (formes officielles, valeurs fictives) ─────────────────────

function campayStatusBody(tx, override) {
  const body = {
    reference: tx.providerReference,
    external_reference: tx.merchantReference,
    status: CAMPAY_STATUS[tx.state],
    amount: tx.amount,
    currency: tx.currency,
    operator: 'MTN',
    code: 'CP-RECIPE-0001',
    operator_reference: null,
    description: 'Abonnement Stock Master',
    external_user: '',
    reason: null,
    endpoint: 'collect',
  };
  if (!override) return body;
  const mapped = { ...override };
  if (mapped.state) {
    mapped.status = CAMPAY_STATUS[mapped.state] || mapped.state;
    delete mapped.state;
  }
  if (mapped.providerReference !== undefined) {
    mapped.reference = mapped.providerReference;
    delete mapped.providerReference;
  }
  if (mapped.merchantReference !== undefined) {
    mapped.external_reference = mapped.merchantReference;
    delete mapped.merchantReference;
  }
  return { ...body, ...mapped };
}

/**
 * Route `/campay/api/...`. Retourne `{ status, body }`, ou `{ destroy: true }`
 * pour une réponse PERDUE (socket détruite après traitement).
 */
function campayRoute(sim, method, pathname, headers, body) {
  if (method === 'POST' && pathname === '/api/token/') {
    sim.tokenCalls += 1;
    if (
      body.username !== FAKE.campayUsername ||
      body.password !== FAKE.campayPassword
    ) {
      return { status: 401, body: { detail: 'invalid credentials' } };
    }
    return { status: 200, body: { token: FAKE.campayToken, expires_in: 3600 } };
  }
  if (headers.authorization !== `Token ${FAKE.campayToken}`) {
    return { status: 401, body: { detail: 'unauthorized' } };
  }
  if (method === 'POST' && pathname === '/api/collect/') {
    sim.collectCalls += 1;
    const amount = Number(body.amount);
    sim.initiations.push({
      face: 'campay',
      merchantReference: body.external_reference,
      amount,
      phoneLength: typeof body.from === 'string' ? body.from.length : 0,
    });
    const request = {
      merchantReference: body.external_reference,
      amount,
      currency: body.currency,
    };
    const behavior = sim.initScript.shift() || 'accept';
    switch (behavior) {
      case 'lost':
        sim.create('campay', request);
        return { destroy: true };
      case 'uncertain-not-created':
        return { destroy: true };
      case 'reject':
        return { status: 400, body: { message: 'ER201' } };
      case 'unavailable':
        return { status: 503, body: { message: 'unavailable' } };
      default: {
        const tx = sim.create('campay', request);
        return {
          status: 200,
          body: {
            reference: tx.providerReference,
            ussd_code: '*126#',
            operator: 'MTN',
          },
        };
      }
    }
  }
  const match = /^\/api\/transaction\/([^/]+)\/$/.exec(pathname);
  if (method === 'GET' && match) {
    const behavior = sim.nextStatusBehavior();
    if (behavior === 'unavailable')
      return { status: 500, body: { message: 'unavailable' } };
    const reference = match[1].toLowerCase();
    const tx = UUID.test(reference)
      ? sim.transactions.get(reference)
      : undefined;
    if (!tx || tx.face !== 'campay' || behavior === 'not-found') {
      return { status: 404, body: { message: 'not found' } };
    }
    return {
      status: 200,
      body: campayStatusBody(
        tx,
        typeof behavior === 'object' ? behavior.override : null,
      ),
    };
  }
  return { status: 404, body: { message: 'unknown route' } };
}

module.exports = {
  SimulationState,
  providerInitiate,
  providerStatus,
  campayRoute,
};
