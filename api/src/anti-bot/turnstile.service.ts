import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  TURNSTILE_SITEVERIFY_URL,
  TURNSTILE_TEST_ACTION,
  TURNSTILE_TOKEN_MAX_LENGTH,
  TurnstileConfigError,
  resolveTurnstileConfig,
  type TurnstileConfig,
} from './turnstile-config';

/** Jeton absent ou mal formé : la vérification n'a pas été faite. */
export const TURNSTILE_REQUIRED = 'TURNSTILE_REQUIRED';
/** Jeton refusé, expiré, déjà utilisé, ou hôte / action inattendus. */
export const TURNSTILE_FAILED = 'TURNSTILE_FAILED';
/** Vérification impossible (fournisseur ou configuration) : réessayer. */
export const TURNSTILE_UNAVAILABLE = 'TURNSTILE_UNAVAILABLE';

/** Erreurs Cloudflare imputables au serveur, pas au visiteur. */
const SERVER_SIDE_ERRORS = new Set([
  'missing-input-secret',
  'invalid-input-secret',
  'bad-request',
  'internal-error',
]);

/**
 * Jetons du vérificateur SIMULÉ (aucun réseau) :
 * `simulated-pass:<action>:<identifiant>` réussit UNE fois pour cette
 * action (rejeu → refus, comme Cloudflare) ; `simulated-unavailable`
 * simule une indisponibilité ; tout autre jeton est refusé.
 */
export const SIMULATED_PASS_PREFIX = 'simulated-pass:';
export const SIMULATED_UNAVAILABLE_TOKEN = 'simulated-unavailable';

interface SiteverifyResponse {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  'error-codes'?: unknown;
}

/**
 * 1-18C — Vérification serveur d'un jeton Turnstile, AVANT toute écriture.
 * Un seul appel `siteverify` borné par `TURNSTILE_TIMEOUT_MS` ; jamais de
 * repli permissif : sans réponse positive exploitable, l'action est refusée.
 * Journal réduit à la raison (jamais le jeton, le secret ni l'adresse).
 */
@Injectable()
export class TurnstileService {
  private readonly logger = new Logger('Turnstile');
  /** Jetons simulés déjà consommés (simulation locale uniquement). */
  private readonly spentSimulatedTokens = new Set<string>();

  /**
   * Vérification possible (clé Cloudflare ou simulation admise) : sinon,
   * aucun défi n'est proposé (le refus temporaire s'applique seul).
   */
  isAvailable(): boolean {
    try {
      return resolveTurnstileConfig(process.env).mode !== 'unconfigured';
    } catch {
      return false;
    }
  }

  async verify(token: unknown, expectedAction: string): Promise<void> {
    let config: TurnstileConfig;
    try {
      config = resolveTurnstileConfig(process.env);
    } catch (error) {
      if (error instanceof TurnstileConfigError) {
        this.logger.warn(`Turnstile: invalid configuration`);
        throw this.unavailable();
      }
      throw error;
    }
    if (config.mode === 'unconfigured') {
      this.logger.warn('Turnstile: not configured, registration refused');
      throw this.unavailable();
    }
    if (
      typeof token !== 'string' ||
      token.trim() === '' ||
      token.length > TURNSTILE_TOKEN_MAX_LENGTH
    ) {
      throw this.required();
    }
    if (config.mode === 'simulated') {
      this.verifySimulated(token, expectedAction);
      return;
    }

    let payload: SiteverifyResponse;
    try {
      const response = await fetch(TURNSTILE_SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: config.secret,
          response: token,
          idempotency_key: randomUUID(),
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) {
        this.logger.warn(`Turnstile: siteverify HTTP ${response.status}`);
        throw this.unavailable();
      }
      payload = (await response.json()) as SiteverifyResponse;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      const reason =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'timeout'
          : 'network';
      this.logger.warn(`Turnstile: siteverify unreachable (${reason})`);
      throw this.unavailable();
    }

    const codes = Array.isArray(payload['error-codes'])
      ? payload['error-codes'].filter((c): c is string => typeof c === 'string')
      : [];
    if (payload.success !== true) {
      if (codes.some((code) => SERVER_SIDE_ERRORS.has(code))) {
        this.logger.warn(`Turnstile: server-side error (${codes.join(',')})`);
        throw this.unavailable();
      }
      throw this.failed();
    }
    const hostname =
      typeof payload.hostname === 'string'
        ? payload.hostname.toLowerCase()
        : '';
    if (!config.hostnames.includes(hostname)) {
      this.logger.warn('Turnstile: unexpected hostname');
      throw this.failed();
    }
    const actionOk =
      payload.action === expectedAction ||
      (config.testKeys && payload.action === TURNSTILE_TEST_ACTION);
    if (!actionOk) {
      this.logger.warn('Turnstile: unexpected action');
      throw this.failed();
    }
  }

  private verifySimulated(token: string, expectedAction: string): void {
    if (token === SIMULATED_UNAVAILABLE_TOKEN) throw this.unavailable();
    const prefix = `${SIMULATED_PASS_PREFIX}${expectedAction}:`;
    if (!token.startsWith(prefix) || token.length === prefix.length) {
      throw this.failed();
    }
    if (this.spentSimulatedTokens.has(token)) throw this.failed();
    this.spentSimulatedTokens.add(token);
  }

  private required(): BadRequestException {
    return new BadRequestException({
      code: TURNSTILE_REQUIRED,
      message: 'Validez la vérification anti-robot, puis réessayez.',
    });
  }

  private failed(): BadRequestException {
    return new BadRequestException({
      code: TURNSTILE_FAILED,
      message:
        'La vérification anti-robot a échoué ou a expiré. Recommencez-la, puis réessayez.',
    });
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: TURNSTILE_UNAVAILABLE,
      message:
        'La vérification anti-robot est momentanément indisponible. Réessayez plus tard.',
    });
  }
}
