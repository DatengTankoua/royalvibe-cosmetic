/**
 * 1-21B — FAUX SasPay de la recette locale (TEST uniquement).
 *
 * Servi par le serveur de contrôle sous `/saspay/api/v1/…` ; l'API de
 * recette y est reliée par un transport de boucle locale injecté dans le VRAI
 * adaptateur (`boot-api.js`, mode `saspay`). Formes reprises de la
 * documentation officielle (enveloppe `{ success, data, code }`, sessions de
 * checkout, statut, liste paginée, `verify`). La page de paiement
 * (`https://pay.saspay.me/checkout/<slug>`) n'existe pas : la recette
 * navigateur l'intercepte et appelle `/sim/saspay/pay`.
 *
 * Aucune donnée réelle : clé et secret FICTIFS (`recipe-common.js`).
 */
'use strict';

const { createHmac, randomUUID } = require('crypto');

class SasPaySimulation {
  constructor(key) {
    this.key = key;
    this.reset();
  }

  reset() {
    this.sessions = new Map();
    this.transactions = new Map();
    this.calls = [];
  }

  reply(status, data) {
    return status >= 400
      ? {
          status,
          body: {
            success: false,
            error: { message: 'Erreur simulée.', code: 'simulated' },
            code: status,
          },
        }
      : { status, body: { success: true, data, code: status } };
  }

  view(s) {
    return {
      id: s.id,
      slug: s.slug,
      checkout_url: `https://pay.saspay.me/checkout/${s.slug}`,
      amount: s.amount,
      currency: s.currency,
      description: s.description,
      country: 'CM',
      customer_email: s.customer_email,
      customer_name: s.customer_name,
      customer_phone: '',
      return_url: s.return_url,
      metadata: s.metadata,
      status: s.status,
      expires_at: s.expires_at,
      transaction: s.transaction,
      paid_at: s.status === 'PAID' ? new Date().toISOString() : null,
    };
  }

  /** Route `/saspay/api/v1/<path>` : `{ status, body }`. */
  route(method, path, headers, body) {
    if (headers.authorization !== `Bearer ${this.key}`) {
      return this.reply(401, null);
    }
    this.calls.push({ method, path });
    let m;
    if (method === 'POST' && path === '/checkout-sessions/') {
      const id = randomUUID();
      const slug = randomUUID().replace(/-/g, '').slice(0, 20);
      const session = {
        id,
        slug,
        amount: String(body.amount),
        currency: String(body.currency),
        description: typeof body.description === 'string' ? body.description : '',
        customer_email: typeof body.customer_email === 'string' ? body.customer_email : '',
        customer_name: typeof body.customer_name === 'string' ? body.customer_name : '',
        return_url: typeof body.return_url === 'string' ? body.return_url : '',
        metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
        status: 'PENDING',
        transaction: null,
        expires_at: typeof body.expires_at === 'string' ? body.expires_at : null,
      };
      this.sessions.set(id, session);
      return this.reply(201, this.view(session));
    }
    if (method === 'GET' && path === '/checkout-sessions/') {
      const all = [...this.sessions.values()].reverse();
      return this.reply(200, {
        count: all.length,
        next: null,
        previous: null,
        results: all.slice(0, 100).map((s) => this.view(s)),
      });
    }
    if ((m = /^\/checkout-sessions\/([^/]+)\/status\/$/.exec(path))) {
      const s = this.sessions.get(m[1]);
      if (!s) return this.reply(404, null);
      const tx = s.transaction ? this.transactions.get(s.transaction) : null;
      return this.reply(200, {
        id: s.id,
        slug: s.slug,
        status: s.status,
        transaction_id: s.transaction,
        transaction_status: tx ? tx.status : null,
      });
    }
    if ((m = /^\/checkout-sessions\/([^/]+)\/$/.exec(path))) {
      const s = this.sessions.get(m[1]);
      return s ? this.reply(200, this.view(s)) : this.reply(404, null);
    }
    if ((m = /^\/payments\/([^/]+)\/verify\/$/.exec(path))) {
      const tx = this.transactions.get(m[1]);
      return tx
        ? this.reply(200, { message: 'Payment transaction fetched successfully', ...tx })
        : this.reply(404, null);
    }
    return this.reply(404, null);
  }

  bySlug(slug) {
    return [...this.sessions.values()].find((s) => s.slug === slug) || null;
  }

  /** Le payeur valide (`SUCCESS`) ou échoue (`FAILED`) sur la page simulée. */
  pay(slug, outcome) {
    const s = this.bySlug(slug);
    if (!s) return null;
    const id = randomUUID();
    this.transactions.set(id, {
      id,
      status: outcome,
      requested_amount: s.amount,
      debited_amount: s.amount,
      net_amount: s.amount,
      currency: s.currency,
      flow_direction: 'INBOUND',
      transaction_type: 'PAIEMENT',
    });
    s.transaction = id;
    if (outcome === 'SUCCESS') s.status = 'PAID';
    return { session: s, transactionId: id };
  }

  /** Notification signée comme SasPay (contrat officiel). */
  signedWebhook(secret, event, transactionId, session) {
    const raw = JSON.stringify({
      event,
      data: {
        id: transactionId,
        reference: `TXN-${transactionId.slice(0, 8)}`,
        type: 'PAIEMENT',
        status: event === 'transaction.success' ? 'SUCCESS' : 'FAILED',
        amount: session.amount,
        currency: session.currency,
        country: 'CM',
        network: 'mtn_cm',
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${raw}`)
      .digest('hex');
    return { raw, timestamp, signature };
  }
}

module.exports = { SasPaySimulation };
