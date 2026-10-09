/**
 * 1-18C — Seuils des plafonds PERSISTANTS (MongoDB, partagés entre
 * instances, conservés au redémarrage). Lus depuis l'environnement et
 * validés strictement ; valeur invalide → `AntiAbuseConfigError` (démarrage
 * bloqué dans `main.ts`).
 *
 * - Échecs d'authentification par identifiant normalisé (login,
 *   `credentials/inspect`, `credentials/accept`) : fenêtre FIXE, aucune
 *   aggravation ; au plus une fenêtre de blocage après la dernière ouverture.
 * - E-mails de création de compte par adresse invitée, toutes invitations et
 *   organisations confondues.
 */
export interface FixedWindowPolicy {
  scope: string;
  limit: number;
  windowMs: number;
}

export interface AntiAbuseConfig {
  accountFailures: FixedWindowPolicy;
  /** Échecs APRÈS défi, par compte ET client (IP ou /64), même fenêtre. */
  challengedFailures: FixedWindowPolicy;
  invitationEmailRecipient: FixedWindowPolicy;
}

export const AUTH_ACCOUNT_FAILURE_SCOPE = 'auth-account-failure';
export const AUTH_CHALLENGED_FAILURE_SCOPE = 'auth-challenged-failure';
export const INVITATION_EMAIL_RECIPIENT_SCOPE = 'invitation-email-recipient';

export const ANTI_ABUSE_SETTINGS = Object.freeze({
  AUTH_ACCOUNT_FAILURE_LIMIT: { def: 10, min: 3, max: 100 },
  AUTH_ACCOUNT_FAILURE_WINDOW_SECONDS: { def: 900, min: 60, max: 3600 },
  AUTH_CHALLENGED_FAILURE_LIMIT: { def: 5, min: 1, max: 20 },
  INVITATION_EMAIL_RECIPIENT_LIMIT: { def: 5, min: 1, max: 50 },
  INVITATION_EMAIL_RECIPIENT_WINDOW_SECONDS: {
    def: 86400,
    min: 3600,
    max: 604800,
  },
});

type SettingName = keyof typeof ANTI_ABUSE_SETTINGS;

export class AntiAbuseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AntiAbuseConfigError';
  }
}

function read(env: NodeJS.ProcessEnv, name: SettingName): number {
  const { def, min, max } = ANTI_ABUSE_SETTINGS[name];
  const raw = (env[name] ?? '').trim();
  if (raw === '') return def;
  if (!/^\d+$/.test(raw)) {
    throw new AntiAbuseConfigError(`${name} doit être un entier.`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new AntiAbuseConfigError(
      `${name} doit être compris entre ${min} et ${max}.`,
    );
  }
  return value;
}

export function resolveAntiAbuseConfig(
  env: NodeJS.ProcessEnv = process.env,
): AntiAbuseConfig {
  return {
    accountFailures: {
      scope: AUTH_ACCOUNT_FAILURE_SCOPE,
      limit: read(env, 'AUTH_ACCOUNT_FAILURE_LIMIT'),
      windowMs: read(env, 'AUTH_ACCOUNT_FAILURE_WINDOW_SECONDS') * 1000,
    },
    challengedFailures: {
      scope: AUTH_CHALLENGED_FAILURE_SCOPE,
      limit: read(env, 'AUTH_CHALLENGED_FAILURE_LIMIT'),
      windowMs: read(env, 'AUTH_ACCOUNT_FAILURE_WINDOW_SECONDS') * 1000,
    },
    invitationEmailRecipient: {
      scope: INVITATION_EMAIL_RECIPIENT_SCOPE,
      limit: read(env, 'INVITATION_EMAIL_RECIPIENT_LIMIT'),
      windowMs: read(env, 'INVITATION_EMAIL_RECIPIENT_WINDOW_SECONDS') * 1000,
    },
  };
}

/** Normalisation du modèle `User.email` (`trim: true`, `lowercase: true`). */
export function normalizeAccountEmail(email: string): string {
  return email.trim().toLowerCase();
}
