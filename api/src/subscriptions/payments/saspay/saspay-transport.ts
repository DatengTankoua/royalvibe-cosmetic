/**
 * 1-21B — Transport HTTP de l'adaptateur SasPay (injectable).
 *
 * Production : `fetch` natif, redirections REFUSÉES (la clé n'est jamais
 * renvoyée vers un autre hôte), annulation effective par `AbortSignal`,
 * corps borné. Tests et recette : faux transport injecté par le code de
 * test uniquement (aucune variable, route ni en-tête ne le sélectionne).
 *
 * Échecs : `not-sent` (aucune connexion établie : la requête n'a
 * CERTAINEMENT pas atteint SasPay) ou `unknown` (elle a PU être exécutée).
 * Les erreurs brutes (URL, en-têtes, corps) ne sont jamais propagées.
 */
export interface SasPayHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
  signal: AbortSignal;
}

export interface SasPayHttpResponse {
  status: number;
  bodyText: string;
}

export type SasPayTransport = (
  request: SasPayHttpRequest,
) => Promise<SasPayHttpResponse>;

export type SasPayTransportFailure = 'not-sent' | 'unknown';

export class SasPayTransportError extends Error {
  constructor(readonly failure: SasPayTransportFailure) {
    super(`SasPay transport failure (${failure}).`);
    this.name = 'SasPayTransportError';
  }
}

/** Corps maximal exploité (une page de 100 sessions comprise). */
export const SASPAY_MAX_RESPONSE_LENGTH = 512 * 1024;

/** Codes undici/Node : aucune connexion établie (requête non transmise). */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export function classifySasPayFetchFailure(
  error: unknown,
): SasPayTransportFailure {
  const cause =
    typeof error === 'object' && error !== null
      ? (error as { cause?: unknown }).cause
      : undefined;
  const code =
    typeof cause === 'object' && cause !== null
      ? (cause as { code?: unknown }).code
      : undefined;
  return typeof code === 'string' && NOT_SENT_CODES.has(code)
    ? 'not-sent'
    : 'unknown';
}

export const fetchSasPayTransport: SasPayTransport = async (request) => {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'error',
      signal: request.signal,
    });
  } catch (error) {
    throw new SasPayTransportError(classifySasPayFetchFailure(error));
  }
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch {
    throw new SasPayTransportError('unknown');
  }
  if (bodyText.length > SASPAY_MAX_RESPONSE_LENGTH) {
    throw new SasPayTransportError('unknown');
  }
  return { status: response.status, bodyText };
};
