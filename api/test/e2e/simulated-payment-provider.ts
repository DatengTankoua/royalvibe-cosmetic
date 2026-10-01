import {
  PaymentCollectionRequest,
  PaymentInitiationResult,
  PaymentProvider,
  PaymentProviderUncertainError,
  PaymentProviderUnavailableError,
  PaymentStatusLookup,
  ProviderPaymentState,
  ProviderPaymentStatus,
} from '../../src/subscriptions/payments/payment-provider';

/**
 * 1-14D.2B — Prestataire SIMULÉ, réservé aux tests (injecté par
 * `overrideProvider(PAYMENT_PROVIDER)`). Aucun réseau, aucun secret.
 *
 * Comportements scriptés, consommés dans l'ordre des appels (puis valeur
 * par défaut) :
 * - initiation : `accept` (défaut), `reject`, `unavailable` (jamais
 *   transmise), `lost` (collecte CRÉÉE puis réponse perdue),
 *   `uncertain-not-created` (incertitude, rien créé) ;
 * - statut : `normal` (défaut), `unavailable`, `not-found`, ou `override`
 *   (champs discordants / réponse obsolète) ;
 * - barrière (`gated`) : l'appel signale son arrivée puis attend sa
 *   libération — ordonnancement DÉTERMINISTE, sans attente arbitraire.
 */

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export type InitiationBehavior =
  'accept' | 'reject' | 'unavailable' | 'lost' | 'uncertain-not-created';

export type StatusBehavior =
  | 'normal'
  | 'unavailable'
  | 'not-found'
  | { override: Partial<ProviderPaymentStatus> };

interface Gated<T> {
  behavior: T;
  reached: Deferred;
  release: Deferred;
  /** Initiation `accept` : collecte CRÉÉE chez le prestataire avant la barrière. */
  createdBeforeGate?: boolean;
}

export interface SimTransaction {
  providerReference: string;
  merchantReference: string;
  amount: number;
  currency: string;
  state: ProviderPaymentState;
}

export class SimulatedPaymentProvider implements PaymentProvider {
  readonly name = 'simulated';
  available = true;
  supportsMerchantReferenceLookup = true;
  readonly idempotentInitiation = false;

  readonly transactions = new Map<string, SimTransaction>();
  readonly initiations: PaymentCollectionRequest[] = [];
  statusCalls = 0;

  private initiationScript: Array<
    InitiationBehavior | Gated<InitiationBehavior>
  > = [];
  private statusScript: Array<StatusBehavior | Gated<StatusBehavior>> = [];
  private sequence = 0;

  reset(): void {
    this.available = true;
    this.supportsMerchantReferenceLookup = true;
    this.transactions.clear();
    this.initiations.length = 0;
    this.statusCalls = 0;
    this.initiationScript = [];
    this.statusScript = [];
  }

  queueInitiation(...behaviors: InitiationBehavior[]): void {
    this.initiationScript.push(...behaviors);
  }

  queueStatus(...behaviors: StatusBehavior[]): void {
    this.statusScript.push(...behaviors);
  }

  /** Prochaine initiation retenue par une barrière. */
  gateInitiation(
    behavior: InitiationBehavior = 'accept',
    options: { createdBeforeGate?: boolean } = {},
  ) {
    const gate = {
      behavior,
      reached: deferred(),
      release: deferred(),
      createdBeforeGate: options.createdBeforeGate === true,
    };
    this.initiationScript.push(gate);
    return {
      reached: gate.reached.promise,
      release: () => gate.release.resolve(),
    };
  }

  /** Prochaine consultation retenue par une barrière. */
  gateStatus(behavior: StatusBehavior = 'normal') {
    const gate = { behavior, reached: deferred(), release: deferred() };
    this.statusScript.push(gate);
    return {
      reached: gate.reached.promise,
      release: () => gate.release.resolve(),
    };
  }

  /** Le payeur valide / refuse chez l'opérateur. */
  settle(merchantReference: string, state: ProviderPaymentState): void {
    const tx = this.byMerchant(merchantReference);
    if (!tx)
      throw new Error(`Transaction simulée absente : ${merchantReference}`);
    tx.state = state;
  }

  byMerchant(merchantReference: string): SimTransaction | undefined {
    return [...this.transactions.values()].find(
      (t) => t.merchantReference === merchantReference,
    );
  }

  async initiate(
    request: PaymentCollectionRequest,
  ): Promise<PaymentInitiationResult> {
    this.initiations.push({ ...request });
    let next = this.initiationScript.shift() ?? 'accept';
    if (typeof next === 'object') {
      // Réponse `accepted` TARDIVE : la collecte existe déjà (et peut être
      // retrouvée par référence marchand) pendant que la réponse est retenue.
      const early =
        next.createdBeforeGate && next.behavior === 'accept'
          ? this.create(request)
          : null;
      next.reached.resolve();
      await next.release.promise;
      if (early) {
        return {
          outcome: 'accepted',
          providerReference: early.providerReference,
        };
      }
      next = next.behavior;
    }
    switch (next) {
      case 'reject':
        return { outcome: 'rejected' };
      case 'unavailable':
        throw new PaymentProviderUnavailableError();
      case 'uncertain-not-created':
        throw new PaymentProviderUncertainError();
      case 'lost':
        this.create(request);
        throw new PaymentProviderUncertainError();
      case 'accept':
        return {
          outcome: 'accepted',
          providerReference: this.create(request).providerReference,
        };
    }
  }

  async fetchStatus(
    lookup: PaymentStatusLookup,
  ): Promise<ProviderPaymentStatus | null> {
    this.statusCalls += 1;
    let next = this.statusScript.shift() ?? 'normal';
    if (typeof next === 'object' && 'release' in next) {
      next.reached.resolve();
      await next.release.promise;
      next = next.behavior;
    }
    if (next === 'unavailable') throw new Error('simulated status outage');
    if (next === 'not-found') return null;
    const tx =
      lookup.by === 'provider'
        ? this.transactions.get(lookup.providerReference)
        : this.byMerchant(lookup.merchantReference);
    if (!tx) return null;
    const status: ProviderPaymentStatus = {
      state: tx.state,
      providerReference: tx.providerReference,
      merchantReference: tx.merchantReference,
      amount: tx.amount,
      currency: tx.currency,
    };
    return typeof next === 'object' ? { ...status, ...next.override } : status;
  }

  private create(request: PaymentCollectionRequest): SimTransaction {
    this.sequence += 1;
    const tx: SimTransaction = {
      providerReference: `SIM-${this.sequence}`,
      merchantReference: request.merchantReference,
      amount: request.amount,
      currency: request.currency,
      state: 'pending',
    };
    this.transactions.set(tx.providerReference, tx);
    return tx;
  }
}
