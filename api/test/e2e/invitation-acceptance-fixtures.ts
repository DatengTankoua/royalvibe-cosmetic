import request from 'supertest';
import type { App } from 'supertest/types';
import type { OutgoingEmail } from '../../src/email-verification/email-sender';
import { INVITATION_TERMS } from './legal-acceptance-fixtures';

/**
 * 1-18B — Parcours réels d'acceptation des invitations pour les E2E :
 * jamais d'écriture directe en base, jamais de raccourci de production.
 */

/** Expéditeur simulé : seule la liste des e-mails acceptés est lue. */
export interface SentEmails {
  sentTo(address: string): OutgoingEmail[];
}

/** Token brut du lien de création de compte (texte de l'e-mail simulé). */
export function accountTokenFrom(email: OutgoingEmail): string {
  const match = /\/auth\/invitations\/create-account\?token=([^\s"&]+)/.exec(
    email.text,
  );
  if (!match) throw new Error('No invitation account link in email');
  return decodeURIComponent(match[1]);
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Demande du lien (public, 202), attente de l'e-mail envoyé à l'adresse
 * invitée, puis renvoi de son token. Échoue si aucun e-mail n'arrive.
 */
export async function requestAccountToken(
  server: App,
  sender: SentEmails,
  invitationToken: string,
  invitedEmail: string,
): Promise<string> {
  const before = sender.sentTo(invitedEmail).length;
  const link = await request(server)
    .post('/auth/invitations/account-link')
    .send({ token: invitationToken });
  if (link.status !== 202) {
    throw new Error(`account-link: HTTP ${link.status}`);
  }
  await waitFor(() => sender.sentTo(invitedEmail).length > before);
  return accountTokenFrom(sender.sentTo(invitedEmail).at(-1)!);
}

/** Création du compte invité comme le web : nom, mot de passe, case cochée. */
export async function createInvitedAccount(
  server: App,
  sender: SentEmails,
  invitationToken: string,
  invitedEmail: string,
  account: { name: string; password: string },
): Promise<request.Response> {
  const token = await requestAccountToken(
    server,
    sender,
    invitationToken,
    invitedEmail,
  );
  return request(server)
    .post('/auth/invitations/create-account')
    .send({ ...INVITATION_TERMS, token, ...account });
}

/** Compte existant : session du compte invité et accord explicite. */
export function acceptWithSession(
  server: App,
  jwt: string,
  invitationToken: string,
): request.Test {
  return request(server)
    .post('/auth/invitations/accept')
    .set('Authorization', `Bearer ${jwt}`)
    .send({ token: invitationToken, consent: true });
}
