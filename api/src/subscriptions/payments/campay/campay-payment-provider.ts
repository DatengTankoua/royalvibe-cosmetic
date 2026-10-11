import {
  PAYMENT_CURRENCY,
  PaymentCollectionRequest,
  PaymentInitiationResult,
  PaymentProvider,
  PaymentProviderUncertainError,
  PaymentProviderUnavailableError,
  PaymentStatusLookup,
  ProviderPaymentState,
  ProviderPaymentStatus,
} from '../payment-provider';
import { MonotonicClock, systemMonotonicClock } from '../../subscription-clock';
import {
  CamPayHttpResponse,
  CamPayTransport,
  CamPayTransportError,
  fetchCamPayTransport,
} from './campay-transport';
import { CAMPAY_PROVIDER_NAME } from './campay-provider-name';

/**
 * 1-14D.2D — Adaptateur CamPay (contrat officiel vérifié le 2026-10-02 :
 * collection Postman « CamPay API » et SDK Python officiel, commit
 * `268868443d`). Voir `docs/architecture/phase-1-14d2d-campay-adapter.md`.
 *
 * NON ACTIVÉ : aucun module ne l'injecte ; le fournisseur de production
 * reste `UnavailablePaymentProvider`. Aucune variable ne le sélectionne.
 *
 * Contrat utilisé (et lui seul) :
 * - `POST /api/token/` `{ username, password }` → `{ token, expires_in }`
 *   (secondes) ; en-tête `Authorization: Token <token>` ;
 * - `POST /api/collect/` `{ amount (entier en chaîne), currency: "XAF",
 *   from: "237…", description, external_reference }` → 200
 *   `{ reference (UUID CamPay), ussd_code, operator }` : collecte CRÉÉE et
 *   en attente (`PENDING`), jamais un paiement réussi ;
 * - `GET /api/transaction/{reference CamPay}/` → `{ reference,
 *   external_reference, status: PENDING|SUCCESSFUL|FAILED, amount, currency,
 *   … }`.
 *
 * Non confirmé, donc NON utilisé : recherche par `external_reference`
 * (`supportsMerchantReferenceLookup = false`), garantie d'idempotence de la
 * collecte (`idempotentInitiation = false`), structure des erreurs portant
 * les codes `ER101/ER102/ER201` (aucun refus n'est donc tenu pour définitif).
 */

/** Origines HTTPS officielles (SDK : `DEV` / `PROD`) ; jamais fournies par un client. */
export const CAMPAY_ORIGINS = Object.freeze({
  demo: 'https://demo.campay.net',
  production: 'https://www.campay.net',
} as const);

export type CamPayEnvironment = keyof typeof CAMPAY_ORIGINS;

/** Budget TOTAL d'un appel `initiate` / `fetchStatus`, authentification comprise. */
export const CAMPAY_CALL_BUDGET_MS = 10_000;

/** Marge de sécurité avant l'expiration annoncée du jeton (`expires_in`). */
export const CAMPAY_TOKEN_SAFETY_MARGIN_MS = 60_000;

export interface CamPayConfig {
  environment: CamPayEnvironment;
  /** Identifiants d'application (« APP KEYS ») — en mémoire seulement. */
  username: string;
  password: string;
  /** Tests uniquement. */
  transport?: CamPayTransport;
  monotonic?: MonotonicClock;
}

const CAMPAY_STATES: Readonly<Record<string, ProviderPaymentState>> =
  Object.freeze({
    PENDING: 'pending',
    SUCCESSFUL: 'succeeded',
    FAILED: 'failed',
  });

/** Référence CamPay : UUID (documenté « UUID4 ») — sûre dans un chemin d'URL. */
const CAMPAY_REFERENCE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Téléphone normalisé par 1-14D.2B (`237` + 9 chiffres). */
const NORMALIZED_PHONE = /^237\d{9}$/;
/** Montant reçu en chaîne : entier décimal exact, sans signe ni zéro de tête. */
const INTEGER_STRING = /^(0|[1-9]\d*)$/;
/**
 * Montant reçu en NOMBRE JSON : représentation lexicale d'ORIGINE d'un
 * entier exact — chiffres, éventuellement suivis de `.0…0` (ex. `3000.0`
 * du contrat). Tout autre littéral (`3000.0000000000000001`,
 * `2999.9999999999999999`, `3e3`, `-1`…) est refusé AVANT conversion.
 */
const INTEGRAL_JSON_NUMBER = /^(0|[1-9]\d*)(?:\.0+)?$/;

/** Erreur INTERNE de consultation : message générique, aucune donnée. */
export class CamPayStatusUnavailableError extends Error {
  constructor(readonly reason: string) {
    super('Statut CamPay indisponible.');
    this.name = 'CamPayStatusUnavailableError';
  }
}

class CamPayTokenError extends Error {
  constructor() {
    super('Authentification CamPay indisponible.');
    this.name = 'CamPayTokenError';
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Analyse d'un corps JSON en conservant la représentation lexicale
 * d'ORIGINE du `amount` de premier niveau (`JSON.parse` arrondit les
 * nombres : `3000.0000000000000001` devient `3000`). Le texte source est
 * fourni par le troisième argument du reviver (« JSON.parse source text
 * access », V8 ≥ 11.4, Node 22). Il n'est ni stocké, ni journalisé, ni
 * renvoyé : seul le montant validé en sort.
 */
export function parseCamPayJson(
  text: string,
): { body: unknown; amountSource: string | undefined } | undefined {
  const amountSources = new Map<object, string>();
  let body: unknown;
  try {
    body = JSON.parse(text, function (
      this: object,
      key: string,
      value: unknown,
      context?: { source?: unknown },
    ) {
      if (
        key === 'amount' &&
        typeof value === 'number' &&
        typeof context?.source === 'string'
      ) {
        amountSources.set(this, context.source);
      }
      return value;
    } as (this: unknown, key: string, value: unknown) => unknown) as unknown;
  } catch {
    return undefined;
  }
  return {
    body,
    amountSource:
      typeof body === 'object' && body !== null
        ? amountSources.get(body)
        : undefined,
  };
}

/**
 * Conversion EXACTE du montant reçu (documentée) :
 * - nombre JSON : sa représentation d'ORIGINE (`source`) doit être un
 *   entier exact (chiffres, éventuellement `.0…0`, ex. `3000.0` du
 *   contrat) ; la valeur est alors reconstruite depuis la partie entière
 *   du TEXTE, puis contrôlée dans la plage sûre. Source absente (runtime
 *   sans accès au texte source) → `null` (échec fermé) ;
 * - chaîne d'entier décimal canonique (le contrat accepte « integer or
 *   string ») ;
 * tout le reste (décimal même infime, négatif, notation exponentielle, zéro
 * de tête, hors plage sûre, absent) → `null` : jamais d'arrondi, de
 * troncature ni de valeur reprise de la demande locale. La concordance
 * 1-14D.2B refuse `null`.
 */
export function parseCamPayAmount(
  value: unknown,
  source?: string,
): number | null {
  if (typeof value === 'number') {
    if (typeof source !== 'string') return null;
    const match = INTEGRAL_JSON_NUMBER.exec(source);
    if (!match) return null;
    const parsed = Number(match[1]);
    return Number.isSafeInteger(parsed) && parsed === value ? parsed : null;
  }
  if (typeof value === 'string' && INTEGER_STRING.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Prestataire CamPay. Aucun appel réseau à la construction ; identifiants
 * explicites, sans valeur par défaut, jamais journalisés ni exposés.
 */
export class CamPayPaymentProvider implements PaymentProvider {
  readonly name = CAMPAY_PROVIDER_NAME;
  readonly available = true;
  readonly supportsMerchantReferenceLookup = false;
  readonly idempotentInitiation = false;

  private readonly origin: string;
  private readonly transport: CamPayTransport;
  private readonly monotonic: MonotonicClock;
  // Identifiants et jeton : champs PRIVÉS (#) — invisibles à l'inspection et
  // à la sérialisation de l'objet.
  readonly #username: string;
  readonly #password: string;
  #token: { value: string; expiresAt: number } | null = null;

  constructor(config: CamPayConfig) {
    const origin = CAMPAY_ORIGINS[config?.environment];
    if (typeof origin !== 'string') {
      throw new Error('Environnement CamPay invalide.');
    }
    if (
      typeof config.username !== 'string' ||
      config.username.length === 0 ||
      typeof config.password !== 'string' ||
      config.password.length === 0
    ) {
      throw new Error('Identifiants CamPay requis.');
    }
    this.origin = origin;
    this.#username = config.username;
    this.#password = config.password;
    this.transport = config.transport ?? fetchCamPayTransport;
    this.monotonic = config.monotonic ?? systemMonotonicClock;
  }

  /**
   * Collecte NON bloquante. `accepted` = collecte créée chez CamPay et en
   * attente du payeur, JAMAIS un paiement réussi. Aucune relance.
   * - échec AVANT l'envoi de la collecte (authentification, budget épuisé,
   *   connexion impossible) → `PaymentProviderUnavailableError` ;
   * - collecte envoyée puis délai, annulation, réponse perdue, inexploitable
   *   ou non-200 → `PaymentProviderUncertainError` (aucune structure
   *   d'erreur officielle ne prouve un refus définitif).
   */
  async initiate(
    request: PaymentCollectionRequest,
  ): Promise<PaymentInitiationResult> {
    const deadline = this.monotonic() + CAMPAY_CALL_BUDGET_MS;
    if (
      !Number.isSafeInteger(request.amount) ||
      request.amount <= 0 ||
      request.currency !== PAYMENT_CURRENCY ||
      typeof request.payerPhone !== 'string' ||
      !NORMALIZED_PHONE.test(request.payerPhone) ||
      typeof request.merchantReference !== 'string' ||
      request.merchantReference.length === 0
    ) {
      throw new PaymentProviderUnavailableError();
    }

    let token: string;
    try {
      token = await this.authorize(deadline);
    } catch {
      // La collecte n'a pas été envoyée.
      throw new PaymentProviderUnavailableError();
    }

    let response: CamPayHttpResponse;
    try {
      response = await this.call(deadline, {
        method: 'POST',
        path: '/api/collect/',
        token,
        body: JSON.stringify({
          amount: String(request.amount),
          currency: request.currency,
          from: request.payerPhone,
          description: request.description,
          external_reference: request.merchantReference,
        }),
      });
    } catch (error) {
      if (
        error instanceof CamPayBudgetExhausted ||
        (error instanceof CamPayTransportError && error.failure === 'not-sent')
      ) {
        throw new PaymentProviderUnavailableError();
      }
      throw new PaymentProviderUncertainError();
    }

    if (response.status === 401) this.#token = null;
    if (response.status !== 200) throw new PaymentProviderUncertainError();
    const body = parseJson(response.bodyText);
    const reference = isRecord(body) ? body.reference : undefined;
    if (typeof reference !== 'string' || !CAMPAY_REFERENCE.test(reference)) {
      // 200 inexploitable : la collecte existe PEUT-ÊTRE.
      throw new PaymentProviderUncertainError();
    }
    // UUID insensible à la casse : forme canonique minuscule, identique à
    // celle renvoyée par `mapCamPayStatus` (concordance 1-14D.2B).
    return { outcome: 'accepted', providerReference: reference.toLowerCase() };
  }

  /**
   * Statut par RÉFÉRENCE CAMPAY uniquement. Notre référence marchand n'est
   * jamais transmise à `/api/transaction/` (recherche non documentée).
   * Toute erreur → statut indisponible (aucune activation, état conservé).
   */
  async fetchStatus(
    lookup: PaymentStatusLookup,
  ): Promise<ProviderPaymentStatus | null> {
    const deadline = this.monotonic() + CAMPAY_CALL_BUDGET_MS;
    if (lookup.by !== 'provider') {
      throw new CamPayStatusUnavailableError('merchant-lookup-unsupported');
    }
    if (!CAMPAY_REFERENCE.test(lookup.providerReference)) {
      throw new CamPayStatusUnavailableError('invalid-reference');
    }
    let token: string;
    try {
      token = await this.authorize(deadline);
    } catch {
      throw new CamPayStatusUnavailableError('auth');
    }
    let response: CamPayHttpResponse;
    try {
      response = await this.call(deadline, {
        method: 'GET',
        path: `/api/transaction/${lookup.providerReference.toLowerCase()}/`,
        token,
      });
    } catch {
      throw new CamPayStatusUnavailableError('transport');
    }
    if (response.status === 401) this.#token = null;
    if (response.status !== 200) {
      throw new CamPayStatusUnavailableError(`http-${response.status}`);
    }
    return mapCamPayStatusText(response.bodyText);
  }

  // ─── Interne ────────────────────────────────────────────────────────────

  /** Jeton en mémoire, réutilisé jusqu'à `expires_in` − marge. */
  private async authorize(deadline: number): Promise<string> {
    const cached = this.#token;
    if (cached && this.monotonic() < cached.expiresAt) return cached.value;
    this.#token = null;
    let response: CamPayHttpResponse;
    try {
      response = await this.call(deadline, {
        method: 'POST',
        path: '/api/token/',
        body: JSON.stringify({
          username: this.#username,
          password: this.#password,
        }),
      });
    } catch {
      throw new CamPayTokenError();
    }
    if (response.status !== 200) throw new CamPayTokenError();
    const body = parseJson(response.bodyText);
    if (!isRecord(body) || typeof body.token !== 'string' || !body.token) {
      throw new CamPayTokenError();
    }
    const expiresIn = body.expires_in;
    if (
      typeof expiresIn === 'number' &&
      Number.isSafeInteger(expiresIn) &&
      expiresIn * 1000 > CAMPAY_TOKEN_SAFETY_MARGIN_MS
    ) {
      this.#token = {
        value: body.token,
        expiresAt:
          this.monotonic() + expiresIn * 1000 - CAMPAY_TOKEN_SAFETY_MARGIN_MS,
      };
    }
    // Durée absente ou trop courte : jeton utilisé une seule fois.
    return body.token;
  }

  /**
   * Un appel HTTP borné par le temps RESTANT de l'échéance unique ;
   * annulation effective du transport à l'expiration.
   */
  private async call(
    deadline: number,
    options: {
      method: 'GET' | 'POST';
      path: string;
      token?: string;
      body?: string;
    },
  ): Promise<CamPayHttpResponse> {
    const remaining = Math.floor(deadline - this.monotonic());
    if (remaining < 1) throw new CamPayBudgetExhausted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      return await this.transport({
        method: options.method,
        url: `${this.origin}${options.path}`,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(options.token ? { Authorization: `Token ${options.token}` } : {}),
        },
        body: options.body,
        signal: controller.signal,
      });
    } catch (error) {
      // Annulation par l'échéance ou autre échec : jamais l'erreur brute.
      if (error instanceof CamPayTransportError) throw error;
      throw new CamPayTransportError('unknown');
    } finally {
      clearTimeout(timer);
    }
  }
}

class CamPayBudgetExhausted extends Error {
  constructor() {
    super('Budget CamPay épuisé avant envoi.');
    this.name = 'CamPayBudgetExhausted';
  }
}

/**
 * Projection du statut OFFICIEL vers le contrat interne, depuis le TEXTE de
 * la réponse (représentation d'origine du montant préservée). Les valeurs
 * sont celles REÇUES : un champ absent n'est jamais remplacé par une valeur
 * de la demande locale (la concordance 1-14D.2B tranche).
 * - corps non JSON ou non objet, `status` absent ou inconnu, `reference`
 *   invalide → statut indisponible (aucune activation, état conservé) ;
 * - `external_reference` vide ou absent → `null` ;
 * - montant : `parseCamPayAmount` (exact) ; devise : chaîne reçue ou `null`.
 */
export function mapCamPayStatusText(text: string): ProviderPaymentStatus {
  const parsed = parseCamPayJson(text);
  if (!parsed) throw new CamPayStatusUnavailableError('body');
  const body = parsed.body;
  if (!isRecord(body)) throw new CamPayStatusUnavailableError('body');
  // Clés PROPRES uniquement (jamais `toString`, `__proto__`…).
  const state =
    typeof body.status === 'string' && Object.hasOwn(CAMPAY_STATES, body.status)
      ? CAMPAY_STATES[body.status]
      : undefined;
  if (!state) throw new CamPayStatusUnavailableError('unknown-status');
  if (
    typeof body.reference !== 'string' ||
    !CAMPAY_REFERENCE.test(body.reference)
  ) {
    throw new CamPayStatusUnavailableError('reference');
  }
  return {
    state,
    providerReference: body.reference.toLowerCase(),
    merchantReference:
      typeof body.external_reference === 'string' &&
      body.external_reference.length > 0
        ? body.external_reference
        : null,
    amount: parseCamPayAmount(body.amount, parsed.amountSource),
    currency: typeof body.currency === 'string' ? body.currency : null,
  };
}
