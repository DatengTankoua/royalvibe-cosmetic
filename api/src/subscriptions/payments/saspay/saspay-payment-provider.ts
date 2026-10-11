import { MonotonicClock, systemMonotonicClock } from '../../subscription-clock';
import {
  PAYMENT_CURRENCY,
  PaymentCollectionRequest,
  PaymentInitiationResult,
  PaymentProvider,
  PaymentProviderInconsistencyError,
  PaymentProviderUncertainError,
  PaymentProviderUnavailableError,
  PaymentStatusLookup,
  ProviderPaymentState,
  ProviderPaymentStatus,
} from '../payment-provider';
import { SASPAY_PROVIDER_NAME, SasPayEnvironment } from './saspay-config';
import {
  SasPayHttpResponse,
  SasPayTransport,
  SasPayTransportError,
  fetchSasPayTransport,
} from './saspay-transport';

/**
 * 1-21B — Adaptateur SasPay : CHECKOUT HÉBERGÉ (rapport 1-21A, § 4).
 *
 * Contrat utilisé, et lui seul (documentation officielle et OpenAPI,
 * consultées le 2026-10-11) :
 * - `POST /checkout-sessions/` `{ amount ("3000.00"), currency, country,
 *   description, customer_email, customer_name, return_url, metadata,
 *   expires_at }` → `{ id, checkout_url, metadata, status, … }`. Pas
 *   d'`Idempotency-Key` sur cette route (documenté) : une réponse perdue
 *   laisse la tentative INCERTAINE, jamais une seconde session ;
 * - `GET /checkout-sessions/{id}/` → `{ id, amount, currency, status,
 *   metadata, transaction, checkout_url }` ;
 * - `GET /checkout-sessions/{id}/status/` → `{ id, status, transaction_id,
 *   transaction_status }` (revérifie le gateway, documenté) ;
 * - `GET /payments/{id}/verify/` → `{ id, status, requested_amount,
 *   debited_amount, net_amount, currency, flow_direction, transaction_type }`
 *   (revérifie le gateway si `PENDING`, documenté) ;
 * - `GET /checkout-sessions/?page=&page_size=` (pagination par numéro,
 *   `next`) : recherche BORNÉE par `metadata.merchantReference` après une
 *   réponse perdue.
 *
 * Enveloppe : `{ success, data, code }` documentée, mais certains exemples
 * l'omettent (et `/countries/` répond enveloppé contrairement à sa page) :
 * les deux formes sont acceptées (1-21A, B3).
 *
 * Preuves EXIGÉES avant un succès : session = celle ENREGISTRÉE ; notre
 * référence dans SA `metadata` ; transaction désignée PAR LA SESSION (route
 * de statut et détail concordants), puis relue (`verify`) avec le même
 * identifiant, `INBOUND`/`PAIEMENT` ; montant DEMANDÉ et montant DÉBITÉ
 * égaux au prix (frais absorbés, décision D8) ; devise identique. La
 * `metadata` seule ne prouve rien sur une transaction.
 *
 * Hypothèses À VÉRIFIER en bac à sable (1-21A, B4) : une session peut-elle
 * porter plusieurs transactions ; un succès peut-il suivre `EXPIRED` ou
 * `CANCELLED`. En attendant : session close ou transaction échouée sans
 * succès → `unresolved` (paiement ouvert, à vérifier), jamais `failed`.
 */

/** Origine OFFICIELLE de l'API ; jamais fournie par une requête. */
export const SASPAY_API_ORIGIN = 'https://api.saspay.me';
export const SASPAY_API_BASE_PATH = '/api/v1';
/** Hôte(s) de checkout documenté(s) (`checkout_url` : `pay.saspay.me`). */
export const SASPAY_CHECKOUT_ORIGINS: readonly string[] = Object.freeze([
  'https://pay.saspay.me',
]);

export const SASPAY_COUNTRY = 'CM';
/** Validité demandée pour une page de paiement. */
export const SASPAY_CHECKOUT_TTL_MS = 30 * 60 * 1000;
/** Budget d'un appel `initiate`. */
export const SASPAY_INITIATE_BUDGET_MS = 10_000;
/** Budget TOTAL d'une consultation (trois routes). */
export const SASPAY_STATUS_BUDGET_MS = 15_000;
/** Recherche après réponse perdue : pages de 100, au plus 5, 20 s. */
export const SASPAY_LOOKUP_PAGE_SIZE = 100;
export const SASPAY_LOOKUP_MAX_PAGES = 5;
export const SASPAY_LOOKUP_BUDGET_MS = 20_000;
/**
 * Limite LOCALE d'appels sortants par processus (documenté : 300 / min par
 * compte, toutes origines confondues) : marge laissée aux autres usages.
 */
export const SASPAY_MAX_CALLS_PER_MINUTE = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Montant décimal exact en chaîne, centimes nuls : `"3000"`, `"3000.00"`. */
const INTEGRAL_DECIMAL = /^(0|[1-9]\d{0,11})(?:\.0{1,2})?$/;
const SESSION_STATES = new Set(['PENDING', 'PAID', 'EXPIRED', 'CANCELLED']);
const TRANSACTION_STATES = new Set([
  'PENDING',
  'SUCCESS',
  'FAILED',
  'CANCELLED',
]);

export interface SasPayProviderConfig {
  environment: SasPayEnvironment;
  secretKey: string;
  /** Tests et recette uniquement. */
  transport?: SasPayTransport;
  monotonic?: MonotonicClock;
  /** Horloge murale (ms), pour `expires_at`. */
  now?: () => number;
}

/** Erreur INTERNE de consultation : message générique, aucune donnée. */
export class SasPayStatusUnavailableError extends Error {
  constructor(readonly reason: string) {
    super('Statut SasPay indisponible.');
    this.name = 'SasPayStatusUnavailableError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Contenu utile : `data` de l'enveloppe documentée, sinon le corps brut. */
export function unwrapSasPayBody(body: unknown): unknown {
  if (isRecord(body) && typeof body.success === 'boolean') {
    return body.success ? body.data : undefined;
  }
  return body;
}

/** `"3000.00"` → 3000 ; tout autre littéral (centimes, signe, nombre) → null. */
export function parseSasPayAmount(value: unknown): number | null {
  if (typeof value !== 'string' || !INTEGRAL_DECIMAL.test(value)) return null;
  const amount = Number(value.split('.')[0]);
  return Number.isSafeInteger(amount) ? amount : null;
}

/** Page de paiement : HTTPS, origine de checkout documentée, sans identifiants. */
export function validCheckoutUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (!SASPAY_CHECKOUT_ORIGINS.includes(url.origin)) return null;
  return url.href;
}

const str = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;
const uuidOrNull = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;

function metadataReference(metadata: unknown): string | null {
  return isRecord(metadata) && typeof metadata.merchantReference === 'string'
    ? metadata.merchantReference
    : null;
}

/**
 * Fenêtre glissante d'appels sortants (par processus) ; au-delà, aucun
 * appel n'est émis (refus local, jamais un dépassement chez SasPay).
 */
class OutboundBudget {
  private readonly calls: number[] = [];
  constructor(
    private readonly max: number,
    private readonly monotonic: MonotonicClock,
  ) {}
  take(): boolean {
    const now = this.monotonic();
    while (this.calls.length > 0 && now - this.calls[0] >= 60_000) {
      this.calls.shift();
    }
    if (this.calls.length >= this.max) return false;
    this.calls.push(now);
    return true;
  }
}

interface SessionFacts {
  id: string;
  amount: number | null;
  currency: string | null;
  status: string;
  merchantReference: string | null;
  transaction: string | null;
  checkoutUrl: string | null;
}

export class SasPayPaymentProvider implements PaymentProvider {
  readonly name = SASPAY_PROVIDER_NAME;
  readonly available = true;
  /** Recherche BORNÉE par `metadata` (liste des sessions, documentée). */
  readonly supportsMerchantReferenceLookup = true;
  /** Aucune idempotence documentée pour la création d'une session. */
  readonly idempotentInitiation = false;
  readonly requiresPayerPhone = false;

  private readonly transport: SasPayTransport;
  private readonly monotonic: MonotonicClock;
  private readonly now: () => number;
  private readonly budget: OutboundBudget;

  constructor(private readonly config: SasPayProviderConfig) {
    this.transport = config.transport ?? fetchSasPayTransport;
    this.monotonic = config.monotonic ?? systemMonotonicClock;
    this.now = config.now ?? Date.now;
    this.budget = new OutboundBudget(
      SASPAY_MAX_CALLS_PER_MINUTE,
      this.monotonic,
    );
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    deadline: number,
    body?: unknown,
  ): Promise<SasPayHttpResponse> {
    const remaining = deadline - this.monotonic();
    if (remaining <= 0) throw new SasPayTransportError('not-sent');
    if (!this.budget.take()) throw new SasPayTransportError('not-sent');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      return await this.transport({
        method,
        url: `${SASPAY_API_ORIGIN}${SASPAY_API_BASE_PATH}${path}`,
        headers: {
          Authorization: `Bearer ${this.config.secretKey}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Création ──────────────────────────────────────────────────────────────

  async initiate(
    request: PaymentCollectionRequest,
  ): Promise<PaymentInitiationResult> {
    const deadline = this.monotonic() + SASPAY_INITIATE_BUDGET_MS;
    const customer = request.customer;
    if (
      !Number.isSafeInteger(request.amount) ||
      request.amount <= 0 ||
      request.currency !== PAYMENT_CURRENCY ||
      typeof request.merchantReference !== 'string' ||
      request.merchantReference.length === 0 ||
      !customer ||
      customer.email.length === 0 ||
      customer.name.trim().length === 0
    ) {
      // Requête invalide : rien n'est envoyé.
      throw new PaymentProviderUnavailableError();
    }
    let response: SasPayHttpResponse;
    try {
      response = await this.call('POST', '/checkout-sessions/', deadline, {
        amount: `${request.amount}.00`,
        currency: request.currency,
        country: SASPAY_COUNTRY,
        description: request.description.slice(0, 200),
        customer_email: customer.email,
        customer_name: customer.name.trim().slice(0, 100),
        ...(request.returnUrl ? { return_url: request.returnUrl } : {}),
        metadata: { merchantReference: request.merchantReference },
        expires_at: new Date(this.now() + SASPAY_CHECKOUT_TTL_MS).toISOString(),
      });
    } catch (error) {
      if (
        error instanceof SasPayTransportError &&
        error.failure === 'not-sent'
      ) {
        throw new PaymentProviderUnavailableError();
      }
      throw new PaymentProviderUncertainError();
    }
    const { status } = response;
    // Refus avant création, documentés (validation, authentification,
    // portée, route, limite de débit) : rien n'a été créé.
    if (status === 400 || status === 422) return { outcome: 'rejected' };
    if (status === 401 || status === 403 || status === 404 || status === 429) {
      throw new PaymentProviderUnavailableError();
    }
    // 409, 5xx, codes inattendus : la session a PU être créée.
    if (status !== 200 && status !== 201) {
      throw new PaymentProviderUncertainError();
    }
    const session = unwrapSasPayBody(parseJson(response.bodyText));
    const id = isRecord(session) ? uuidOrNull(session.id) : null;
    const checkoutUrl = isRecord(session)
      ? validCheckoutUrl(session.checkout_url)
      : null;
    const echoed = isRecord(session)
      ? metadataReference(session.metadata)
      : null;
    // Session créée mais inexploitable (identifiant, page non autorisée,
    // référence étrangère) : incertaine, jamais une seconde session.
    if (
      !id ||
      !checkoutUrl ||
      (echoed !== null && echoed !== request.merchantReference)
    ) {
      throw new PaymentProviderUncertainError();
    }
    return {
      outcome: 'accepted',
      providerReference: id,
      redirectUrl: checkoutUrl,
    };
  }

  // ─── Consultation ──────────────────────────────────────────────────────────

  async fetchStatus(
    lookup: PaymentStatusLookup,
  ): Promise<ProviderPaymentStatus | null> {
    if (lookup.by === 'merchant') {
      const id = await this.findSessionByMerchantReference(
        lookup.merchantReference,
      );
      return id === null ? null : this.statusOfSession(id);
    }
    const id = uuidOrNull(lookup.providerReference);
    if (!id) throw new SasPayStatusUnavailableError('invalid-reference');
    return this.statusOfSession(id);
  }

  private async getJson(
    path: string,
    deadline: number,
  ): Promise<{ status: number; data: unknown }> {
    let response: SasPayHttpResponse;
    try {
      response = await this.call('GET', path, deadline);
    } catch {
      throw new SasPayStatusUnavailableError('transport');
    }
    return {
      status: response.status,
      data: unwrapSasPayBody(parseJson(response.bodyText)),
    };
  }

  private async statusOfSession(
    sessionId: string,
  ): Promise<ProviderPaymentStatus | null> {
    const deadline = this.monotonic() + SASPAY_STATUS_BUDGET_MS;

    // 1. Session ENREGISTRÉE : référence, montant, devise, transaction.
    const detail = await this.getJson(
      `/checkout-sessions/${sessionId}/`,
      deadline,
    );
    if (detail.status === 404) return null;
    if (detail.status !== 200 || !isRecord(detail.data)) {
      throw new SasPayStatusUnavailableError('session');
    }
    const session = this.sessionFacts(detail.data);
    if (!session || session.id !== sessionId) {
      throw new SasPayStatusUnavailableError('session-shape');
    }

    // 2. Statut revérifié côté gateway (route dédiée, documentée).
    const live = await this.getJson(
      `/checkout-sessions/${sessionId}/status/`,
      deadline,
    );
    if (live.status !== 200 || !isRecord(live.data)) {
      throw new SasPayStatusUnavailableError('session-status');
    }
    const liveId = uuidOrNull(live.data.id);
    const liveStatus = str(live.data.status);
    if (
      liveId !== sessionId ||
      !liveStatus ||
      !SESSION_STATES.has(liveStatus)
    ) {
      throw new SasPayStatusUnavailableError('session-status-shape');
    }
    const liveTransaction = uuidOrNull(live.data.transaction_id);
    // Transaction désignée différemment par les deux routes : jamais
    // départagé (vérification opérateur).
    if (
      liveTransaction !== null &&
      session.transaction !== null &&
      liveTransaction !== session.transaction
    ) {
      throw new PaymentProviderInconsistencyError('inconsistent-attachment');
    }
    const transactionId = liveTransaction ?? session.transaction;

    const base = {
      providerReference: sessionId,
      merchantReference: session.merchantReference,
      providerTransactionId: transactionId,
      checkoutUrl: liveStatus === 'PENDING' ? session.checkoutUrl : null,
    };

    if (transactionId === null) {
      // Session payée sans transaction désignée : incohérent.
      if (liveStatus === 'PAID') {
        throw new PaymentProviderInconsistencyError('inconsistent-attachment');
      }
      return {
        ...base,
        state: liveStatus === 'PENDING' ? 'pending' : 'unresolved',
        amount: session.amount,
        currency: session.currency,
      };
    }

    // 3. Transaction RELUE par l'identifiant que la session désigne.
    const verified = await this.getJson(
      `/payments/${transactionId}/verify/`,
      deadline,
    );
    if (verified.status === 404) {
      // Désignée par la session mais introuvable : temporaire / opérateur.
      throw new SasPayStatusUnavailableError('transaction-not-found');
    }
    if (verified.status !== 200 || !isRecord(verified.data)) {
      throw new SasPayStatusUnavailableError('transaction');
    }
    const tx = verified.data;
    const txStatus = str(tx.status);
    if (
      uuidOrNull(tx.id) !== transactionId ||
      !txStatus ||
      !TRANSACTION_STATES.has(txStatus)
    ) {
      throw new PaymentProviderInconsistencyError('inconsistent-attachment');
    }
    if (
      (tx.flow_direction !== undefined && tx.flow_direction !== 'INBOUND') ||
      (tx.transaction_type !== undefined && tx.transaction_type !== 'PAIEMENT')
    ) {
      throw new PaymentProviderInconsistencyError('inconsistent-attachment');
    }
    const requested = parseSasPayAmount(tx.requested_amount);
    const debited = parseSasPayAmount(tx.debited_amount);
    // Frais absorbés (D8) : le payeur est débité EXACTEMENT du prix ; le
    // montant net (prix − frais) n'entre pas dans la concordance.
    const amount =
      session.amount !== null &&
      requested === session.amount &&
      debited === session.amount
        ? session.amount
        : null;
    const currency =
      str(tx.currency) === session.currency ? session.currency : null;

    let state: ProviderPaymentState;
    if (txStatus === 'SUCCESS') state = 'succeeded';
    else if (txStatus === 'PENDING') state = 'pending';
    // Échec ou annulation : nouvelle tentative possible sur une page encore
    // ouverte ; sinon à vérifier (succès tardif non exclu par le contrat).
    else state = liveStatus === 'PENDING' ? 'pending' : 'unresolved';
    return { ...base, state, amount, currency };
  }

  private sessionFacts(data: Record<string, unknown>): SessionFacts | null {
    const id = uuidOrNull(data.id);
    const status = str(data.status);
    if (!id || !status || !SESSION_STATES.has(status)) return null;
    const transaction =
      data.transaction === null || data.transaction === undefined
        ? null
        : uuidOrNull(data.transaction);
    if (data.transaction != null && transaction === null) return null;
    return {
      id,
      amount: parseSasPayAmount(data.amount),
      currency: str(data.currency),
      status,
      merchantReference: metadataReference(data.metadata),
      transaction,
      checkoutUrl: validCheckoutUrl(data.checkout_url),
    };
  }

  /**
   * Recherche BORNÉE d'une session portant notre référence (réponse perdue).
   * `null` : aucune trouvée DANS les pages lues — jamais une preuve
   * d'absence. Plusieurs : jamais départagées (incohérence).
   */
  private async findSessionByMerchantReference(
    merchantReference: string,
  ): Promise<string | null> {
    const deadline = this.monotonic() + SASPAY_LOOKUP_BUDGET_MS;
    const matches = new Set<string>();
    for (let page = 1; page <= SASPAY_LOOKUP_MAX_PAGES; page += 1) {
      const listed = await this.getJson(
        `/checkout-sessions/?page=${page}&page_size=${SASPAY_LOOKUP_PAGE_SIZE}`,
        deadline,
      );
      if (listed.status !== 200 || !isRecord(listed.data)) {
        throw new SasPayStatusUnavailableError('lookup');
      }
      const results = listed.data.results;
      if (!Array.isArray(results)) {
        throw new SasPayStatusUnavailableError('lookup-shape');
      }
      for (const item of results) {
        if (!isRecord(item)) continue;
        if (metadataReference(item.metadata) !== merchantReference) continue;
        const id = uuidOrNull(item.id);
        if (id) matches.add(id);
      }
      if (matches.size > 1) {
        throw new PaymentProviderInconsistencyError('ambiguous-lookup');
      }
      if (listed.data.next === null || listed.data.next === undefined) break;
    }
    return matches.size === 1 ? [...matches][0] : null;
  }
}
