/**
 * 1-16C.1 — Assistance depuis l'organisation : constantes centralisées.
 *
 * Le destinataire est FIXÉ ici, côté serveur : aucune valeur envoyée par le
 * navigateur ne peut le remplacer ni ajouter de destinataire.
 */
export const SUPPORT_RECIPIENT = 'support@stock-master.app';

export const SUPPORT_CATEGORIES = Object.freeze({
  usage: 'Utilisation',
  subscription: 'Abonnement',
  technical: 'Problème technique',
  other: 'Autre',
} as const);

export type SupportCategory = keyof typeof SUPPORT_CATEGORIES;

/** Bornes du formulaire (miroir web : lib/support.ts). */
export const SUPPORT_SUBJECT_MAX_LENGTH = 150;
export const SUPPORT_MESSAGE_MAX_LENGTH = 5000;
export const SUPPORT_PAGE_MAX_LENGTH = 200;
export const SUPPORT_APP_VERSION_MAX_LENGTH = 40;

/**
 * Resend conserve une clé d'idempotence 24 heures. Un envoi dont le
 * résultat est INCONNU n'est renvoyé avec la même clé que dans cette
 * fenêtre (marge d'une heure) ; au-delà, aucun renvoi automatique : la
 * déduplication du prestataire n'est plus garantie.
 */
export const SUPPORT_UNCERTAIN_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

/** Verrou d'un envoi en cours (double clic, requêtes concurrentes). */
export const SUPPORT_SEND_LOCK_MS = 60 * 1000;

/**
 * Durée de vie du registre anti-doublon (`support_requests`), appliquée par
 * l'index TTL de la migration `create-support-request-indexes`. Le contenu
 * du message n'y est jamais conservé.
 */
export const SUPPORT_REQUEST_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export const SUPPORT_CLOCK = Symbol('SUPPORT_CLOCK');
export type SupportClock = () => Date;
