import { randomUUID } from 'crypto';
import type {
  SasPayHttpRequest,
  SasPayHttpResponse,
  SasPayTransport,
} from '../../src/subscriptions/payments/saspay/saspay-transport';
import { SasPayTransportError } from '../../src/subscriptions/payments/saspay/saspay-transport';

/**
 * 1-21B — FAUX SasPay (TEST uniquement) : reproduit les FORMES documentées
 * des routes utilisées par l'adaptateur (sessions de checkout, statut,
 * liste paginée, `verify`). Branché comme TRANSPORT de l'adaptateur réel :
 * aucune variable, route ni en-tête de production ne peut le sélectionner.
 *
 * Comportements DOCUMENTÉS reproduits : enveloppe `{ success, data, code }`,
 * statuts de session et de transaction, 404 inconnu, pagination `next`.
 * HYPOTHÈSES (à confirmer en bac à sable, rapport 1-21B) : rattachement
 * d'UNE transaction par session (la dernière tentative), succès possible
 * après expiration, cohérence des deux routes de session.
 */
export const FAKE_SASPAY_KEY = 'sk_test_fake-e2e-saspay-0001';
const API_PREFIX = 'https://api.saspay.me/api/v1';

export interface FakeSession {
  id: string;
  slug: string;
  amount: string;
  currency: string;
  description: string;
  customer_email: string;
  customer_name: string;
  return_url: string;
  metadata: Record<string, unknown>;
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  transaction: string | null;
  expires_at: string | null;
}

export interface FakeTransaction {
  id: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  requested_amount: string;
  debited_amount: string;
  net_amount: string;
  currency: string;
  flow_direction: string;
  transaction_type: string;
}

export type CreateBehavior =
  | 'normal'
  /** Session créée, réponse perdue (transport `unknown`). */
  | 'lost-after-create'
  /** Rien créé, transport `not-sent`. */
  | 'not-sent'
  | 'reject-422'
  /** Session créée, réponse 500. */
  | 'error-500-after-create'
  /** Réponse 201 avec une page hors de l'hôte autorisé. */
  | 'foreign-checkout-url';

const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';

export class FakeSasPay {
  readonly sessions = new Map<string, FakeSession>();
  readonly transactions = new Map<string, FakeTransaction>();
  readonly calls: Array<{ method: string; path: string }> = [];
  /** Réponses enveloppées (documenté) ou brutes (exemples). */
  envelope = true;
  nextCreate: CreateBehavior = 'normal';
  /** Panne de consultation (transport `unknown`). */
  statusOutage = false;
  /** `status/` désigne une autre transaction que le détail. */
  inconsistentStatusRoute = false;

  readonly transport: SasPayTransport = (request) => this.handle(request);

  private reply(status: number, data: unknown): SasPayHttpResponse {
    const body =
      status >= 400
        ? {
            success: false,
            error: { message: 'Erreur simulée.', code: 'simulated' },
            code: status,
          }
        : this.envelope
          ? { success: true, data, code: status }
          : data;
    return { status, bodyText: JSON.stringify(body) };
  }

  private handle(request: SasPayHttpRequest): Promise<SasPayHttpResponse> {
    try {
      return Promise.resolve(this.route(request));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('fake'));
    }
  }

  private route(request: SasPayHttpRequest): SasPayHttpResponse {
    if (!request.url.startsWith(API_PREFIX)) {
      throw new SasPayTransportError('not-sent');
    }
    if (request.headers.Authorization !== `Bearer ${FAKE_SASPAY_KEY}`) {
      return this.reply(401, null);
    }
    const url = new URL(request.url);
    const path = url.pathname.slice('/api/v1'.length);
    this.calls.push({ method: request.method, path });

    if (request.method === 'POST' && path === '/checkout-sessions/') {
      return this.create(
        JSON.parse(request.body ?? '{}') as Record<string, unknown>,
      );
    }
    if (this.statusOutage) throw new SasPayTransportError('unknown');

    let m: RegExpExecArray | null;
    if (request.method === 'GET' && path === '/checkout-sessions/') {
      const page = Number(url.searchParams.get('page') ?? 1);
      const size = Number(url.searchParams.get('page_size') ?? 20);
      const all = [...this.sessions.values()].reverse();
      const results = all
        .slice((page - 1) * size, page * size)
        .map((s) => this.view(s));
      const next =
        page * size < all.length
          ? `${API_PREFIX}/checkout-sessions/?page=${page + 1}&page_size=${size}`
          : null;
      return this.reply(200, {
        count: all.length,
        next,
        previous: null,
        results,
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
        transaction_id: this.inconsistentStatusRoute
          ? randomUUID()
          : s.transaction,
        transaction_status: tx?.status ?? null,
        transaction_reference: tx ? `TXN-${tx.id.slice(0, 8)}` : null,
      });
    }
    if ((m = /^\/checkout-sessions\/([^/]+)\/$/.exec(path))) {
      const s = this.sessions.get(m[1]);
      return s ? this.reply(200, this.view(s)) : this.reply(404, null);
    }
    if ((m = /^\/payments\/([^/]+)\/verify\/$/.exec(path))) {
      const tx = this.transactions.get(m[1]);
      return tx
        ? this.reply(200, {
            message: 'Payment transaction fetched successfully',
            ...tx,
            reference: `TXN-${tx.id.slice(0, 8)}`,
            fee_charge_mode: 'DEDUCTED',
          })
        : this.reply(404, null);
    }
    return this.reply(404, null);
  }

  private create(body: Record<string, unknown>): SasPayHttpResponse {
    const behavior = this.nextCreate;
    this.nextCreate = 'normal';
    if (behavior === 'not-sent') throw new SasPayTransportError('not-sent');
    if (behavior === 'reject-422') return this.reply(422, null);
    const id = randomUUID();
    const slug = randomUUID().replace(/-/g, '').slice(0, 20);
    const session: FakeSession = {
      id,
      slug,
      amount: String(body.amount),
      currency: String(body.currency),
      description: text(body.description),
      customer_email: text(body.customer_email),
      customer_name: text(body.customer_name),
      return_url: text(body.return_url),
      metadata: (body.metadata as Record<string, unknown>) ?? {},
      status: 'PENDING',
      transaction: null,
      expires_at: typeof body.expires_at === 'string' ? body.expires_at : null,
    };
    this.sessions.set(id, session);
    if (behavior === 'lost-after-create')
      throw new SasPayTransportError('unknown');
    if (behavior === 'error-500-after-create') return this.reply(500, null);
    const view = this.view(session);
    if (behavior === 'foreign-checkout-url') {
      return this.reply(201, {
        ...view,
        checkout_url: `https://evil.example/checkout/${slug}`,
      });
    }
    return this.reply(201, view);
  }

  view(s: FakeSession): Record<string, unknown> {
    return {
      id: s.id,
      merchant: 'merchant-1',
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
      fee_charge_mode: '',
      status: s.status,
      expires_at: s.expires_at,
      transaction: s.transaction,
      payment_link: null,
      paid_at: s.status === 'PAID' ? new Date().toISOString() : null,
    };
  }

  // ─── Pilotage ────────────────────────────────────────────────────────────

  /** Le payeur tente de payer : nouvelle transaction rattachée à la session. */
  attempt(
    sessionId: string,
    status: FakeTransaction['status'],
    options: { debited?: string; requested?: string; currency?: string } = {},
  ): string {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('session inconnue');
    const id = randomUUID();
    this.transactions.set(id, {
      id,
      status,
      requested_amount: options.requested ?? s.amount,
      debited_amount: options.debited ?? s.amount,
      net_amount: s.amount,
      currency: options.currency ?? s.currency,
      flow_direction: 'INBOUND',
      transaction_type: 'PAIEMENT',
    });
    s.transaction = id;
    if (status === 'SUCCESS') s.status = 'PAID';
    return id;
  }

  settle(transactionId: string, status: FakeTransaction['status']): void {
    const tx = this.transactions.get(transactionId);
    if (!tx) throw new Error('transaction inconnue');
    tx.status = status;
    for (const s of this.sessions.values()) {
      if (s.transaction === transactionId && status === 'SUCCESS')
        s.status = 'PAID';
    }
  }

  close(sessionId: string, status: 'EXPIRED' | 'CANCELLED'): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('session inconnue');
    s.status = status;
  }

  /** Session étrangère portant une référence donnée (correspondances multiples). */
  addForeignSession(merchantReference: string, amount = '3000.00'): string {
    const id = randomUUID();
    this.sessions.set(id, {
      id,
      slug: randomUUID().replace(/-/g, '').slice(0, 20),
      amount,
      currency: 'XAF',
      description: '',
      customer_email: 'x@example.com',
      customer_name: 'X',
      return_url: '',
      metadata: { merchantReference },
      status: 'PENDING',
      transaction: null,
      expires_at: null,
    });
    return id;
  }

  sessionByReference(merchantReference: string): FakeSession | undefined {
    return [...this.sessions.values()].find(
      (s) => s.metadata.merchantReference === merchantReference,
    );
  }

  count(method: string, pathPrefix: string): number {
    return this.calls.filter(
      (c) => c.method === method && c.path.startsWith(pathPrefix),
    ).length;
  }
}
