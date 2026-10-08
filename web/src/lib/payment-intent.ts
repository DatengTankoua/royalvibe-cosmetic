import {
  SUBSCRIPTION_OFFERS,
  type SubscriptionTerm,
} from "./subscription-offers";
import { UUID_V4 } from "./subscription-payments";

// 1-14D.2C — Marqueur MINIMAL de reprise d'une intention de paiement.
//
// Rôle unique : rejouer la MÊME demande (même `clientOperationId`, même
// durée) après une réponse perdue ou un rechargement, et retrouver le
// paiement déjà connu. Ce n'est JAMAIS une preuve de paiement : l'état
// affiché vient toujours d'une lecture serveur.
//
// - Portée : utilisateur + organisation (identifiants issus du contexte
//   serveur) ; une autre identité ne lit jamais l'entrée d'une autre.
// - Contenu : UUID, durée, identifiant de paiement s'il est connu, date
//   locale. JAMAIS de téléphone, de jeton, de montant ou de statut.
// - `localStorage` : survit au rechargement, à la réauthentification et aux
//   onglets ; stockage non fiable (effaçable, indisponible) → au pire, le
//   paiement ouvert est retrouvé par l'historique serveur.

const PAYMENT_INTENT_KEY = "stockmaster_payment_intents";
const MAX_ENTRIES = 20;

export interface PaymentIdentity {
  userId: string;
  organizationId: string;
}

export interface PaymentIntent extends PaymentIdentity {
  /** `null` : paiement ouvert découvert ailleurs (autre onglet/appareil). */
  clientOperationId: string | null;
  term: SubscriptionTerm;
  paymentId: string | null;
  savedAt: number;
}

const ALLOWED_KEYS = new Set([
  "userId",
  "organizationId",
  "clientOperationId",
  "term",
  "paymentId",
  "savedAt",
]);

const isId = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{24}$/i.test(v);
const isTerm = (v: unknown): v is SubscriptionTerm =>
  SUBSCRIPTION_OFFERS.some((offer) => offer.term === v);

/** Entrée strictement conforme, sinon `null` (jamais de champ inconnu). */
function parseEntry(value: unknown): PaymentIntent | null {
  if (typeof value !== "object" || value === null) return null;
  const e = value as Record<string, unknown>;
  if (Object.keys(e).some((key) => !ALLOWED_KEYS.has(key))) return null;
  if (!isId(e.userId) || !isId(e.organizationId) || !isTerm(e.term)) {
    return null;
  }
  const clientOperationId =
    e.clientOperationId === null
      ? null
      : typeof e.clientOperationId === "string" &&
          UUID_V4.test(e.clientOperationId)
        ? e.clientOperationId
        : undefined;
  const paymentId =
    e.paymentId === null ? null : isId(e.paymentId) ? e.paymentId : undefined;
  if (clientOperationId === undefined || paymentId === undefined) return null;
  if (clientOperationId === null && paymentId === null) return null;
  return {
    userId: e.userId,
    organizationId: e.organizationId,
    clientOperationId,
    term: e.term,
    paymentId,
    savedAt: typeof e.savedAt === "number" ? e.savedAt : 0,
  };
}

function readAll(): PaymentIntent[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PAYMENT_INTENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.map(parseEntry).filter((e): e is PaymentIntent => e !== null)
      : [];
  } catch {
    return [];
  }
}

function writeAll(entries: PaymentIntent[]): void {
  try {
    window.localStorage.setItem(
      PAYMENT_INTENT_KEY,
      JSON.stringify(entries.slice(-MAX_ENTRIES)),
    );
  } catch {
    // Stockage indisponible : la reprise passera par l'historique serveur.
  }
}

const same = (e: PaymentIdentity, identity: PaymentIdentity) =>
  e.userId === identity.userId && e.organizationId === identity.organizationId;

export function readPaymentIntent(
  identity: PaymentIdentity,
): PaymentIntent | null {
  return readAll().find((e) => same(e, identity)) ?? null;
}

/** Écrit l'intention de CETTE identité (une seule par identité). */
export function writePaymentIntent(intent: PaymentIntent): void {
  const entry = parseEntry({
    userId: intent.userId,
    organizationId: intent.organizationId,
    clientOperationId: intent.clientOperationId,
    term: intent.term,
    paymentId: intent.paymentId,
    savedAt: intent.savedAt,
  });
  if (!entry) return;
  writeAll([...readAll().filter((e) => !same(e, entry)), entry]);
}

export function clearPaymentIntent(identity: PaymentIdentity): void {
  const entries = readAll();
  const kept = entries.filter((e) => !same(e, identity));
  if (kept.length !== entries.length) writeAll(kept);
}
