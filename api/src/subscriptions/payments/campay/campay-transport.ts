/**
 * 1-14D.2D — Transport HTTP de l'adaptateur CamPay (injectable).
 *
 * Production : `fetch` natif de Node 22 (même convention que
 * `ResendEmailSender`) — aucun package ajouté, redirections REFUSÉES
 * (`redirect: 'error'` : les identifiants ne sont jamais renvoyés vers un
 * autre hôte), annulation EFFECTIVE par `AbortSignal` (la requête undici est
 * interrompue, pas seulement ignorée). Tests : faux transport injecté.
 *
 * Classification des échecs de transport :
 * - `not-sent` : la requête n'a CERTAINEMENT pas atteint CamPay (connexion
 *   refusée, nom introuvable, délai de CONNEXION dépassé) ;
 * - `unknown`  : tout le reste (délai ou annulation après connexion,
 *   connexion réinitialisée, redirection reçue, corps illisible…) — la
 *   requête a PU être exécutée.
 * Les objets d'erreur bruts (qui peuvent contenir l'URL, les en-têtes ou le
 * corps) ne sont jamais propagés ni journalisés.
 */

export interface CamPayHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
  /** Annule la requête à l'échéance (budget de l'adaptateur). */
  signal: AbortSignal;
}

export interface CamPayHttpResponse {
  status: number;
  /** Corps texte, borné ; jamais journalisé. */
  bodyText: string;
}

export type CamPayTransport = (
  request: CamPayHttpRequest,
) => Promise<CamPayHttpResponse>;

export type CamPayTransportFailure = 'not-sent' | 'unknown';

export class CamPayTransportError extends Error {
  constructor(readonly failure: CamPayTransportFailure) {
    // Message GÉNÉRIQUE : aucune URL, aucun en-tête, aucun corps.
    super(`CamPay transport failure (${failure}).`);
    this.name = 'CamPayTransportError';
  }
}

/** Taille maximale d'un corps de réponse exploité (octets/caractères). */
export const CAMPAY_MAX_RESPONSE_LENGTH = 64 * 1024;

/**
 * Codes undici/Node signifiant qu'aucune connexion n'a été établie : la
 * requête n'a pas pu être transmise au serveur.
 */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function causeCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function classifyFetchFailure(error: unknown): CamPayTransportFailure {
  const code = causeCode(error);
  return code !== undefined && NOT_SENT_CODES.has(code)
    ? 'not-sent'
    : 'unknown';
}

/** Transport de production (aucun appel réseau à la construction). */
export const fetchCamPayTransport: CamPayTransport = async (request) => {
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
    throw new CamPayTransportError(classifyFetchFailure(error));
  }
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch {
    throw new CamPayTransportError('unknown');
  }
  if (bodyText.length > CAMPAY_MAX_RESPONSE_LENGTH) {
    throw new CamPayTransportError('unknown');
  }
  return { status: response.status, bodyText };
};
