import { escapeHtml } from '../email-verification/verification-email';
import { SUPPORT_CATEGORIES, type SupportCategory } from './support-constants';

/**
 * 1-16C.1 — Message envoyé au service client. Fonction PURE : mêmes entrées
 * → même sujet, même texte, même HTML (condition de l'idempotence Resend :
 * un rejeu doit envoyer exactement le même corps). Toutes les valeurs
 * dynamiques sont échappées en HTML ; le sujet est sur une seule ligne.
 */

const ROLE_LABELS: Record<string, string> = {
  owner: 'Propriétaire',
  admin: 'Administrateur',
  seller: 'Vendeur',
};

export interface SupportEmailInput {
  requestId: string;
  reference: string;
  createdAt: Date;
  category: SupportCategory;
  subject: string;
  message: string;
  page: string | null;
  appVersion: string | null;
  userId: string;
  organizationId: string;
  membershipId: string;
  context: {
    userName: string;
    userEmail: string;
    organizationName: string;
    organizationSlug: string | null;
    role: string;
    permissions: string[];
  };
}

export interface SupportEmailContent {
  subject: string;
  text: string;
  html: string;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

/** Date lisible déterministe (fuseau du Cameroun) + ISO UTC. */
function formatDate(date: Date): string {
  const local = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Africa/Douala',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(date);
  return `${local} (heure de Douala) — ${date.toISOString()}`;
}

export function buildSupportEmail(
  input: SupportEmailInput,
): SupportEmailContent {
  const category = SUPPORT_CATEGORIES[input.category];
  const role = ROLE_LABELS[input.context.role] ?? input.context.role;
  const subject = singleLine(
    `[Assistance Stock Master] ${category} : ${input.subject} (${input.reference})`,
  );

  const details: Array<[string, string]> = [
    ['Référence', input.reference],
    ['Reçue le', formatDate(input.createdAt)],
    ['Catégorie', category],
    [
      'Demandeur',
      `${singleLine(input.context.userName)} <${input.context.userEmail}>`,
    ],
    ['Commerce', singleLine(input.context.organizationName)],
    ['Identifiant du commerce (slug)', input.context.organizationSlug ?? '—'],
    ['Rôle', role],
    [
      'Droits effectifs',
      input.context.permissions.length > 0
        ? input.context.permissions.join(', ')
        : '—',
    ],
    ['Identifiant utilisateur', input.userId],
    ['Identifiant organisation', input.organizationId],
    ['Identifiant d’appartenance', input.membershipId],
    ['Page concernée', input.page ?? '—'],
    ['Version de l’application', input.appVersion ?? '—'],
    ['Identifiant de la demande', input.requestId],
  ];

  const text = [
    'Nouvelle demande d’assistance envoyée depuis Stock Master.',
    '',
    `Sujet : ${singleLine(input.subject)}`,
    '',
    'Message :',
    input.message,
    '',
    '— Informations jointes automatiquement par le serveur —',
    ...details.map(([label, value]) => `${label} : ${value}`),
    '',
    'Répondre à cet e-mail écrit directement au demandeur.',
  ].join('\n');

  const rows = details
    .map(
      ([label, value]) =>
        `<tr><th style="text-align:left;padding:4px 12px 4px 0;vertical-align:top;color:#3d4e66;font-weight:600;">${escapeHtml(label)}</th><td style="padding:4px 0;vertical-align:top;">${escapeHtml(value)}</td></tr>`,
    )
    .join('');

  const html = `<!doctype html>
<html lang="fr">
  <body style="font-family: Arial, sans-serif; color: #111827; line-height: 1.5;">
    <p style="color:#062B5C;font-weight:bold;">Nouvelle demande d’assistance envoyée depuis Stock Master</p>
    <p><strong>Sujet :</strong> ${escapeHtml(singleLine(input.subject))}</p>
    <p><strong>Message :</strong></p>
    <div style="white-space: pre-wrap; border-left: 3px solid #062B5C; padding-left: 12px;">${escapeHtml(input.message)}</div>
    <p style="margin-top:24px;color:#062B5C;font-weight:bold;">Informations jointes automatiquement par le serveur</p>
    <table style="border-collapse: collapse; font-size: 14px;">${rows}</table>
    <p style="color: #6b7280; font-size: 13px;">Répondre à cet e-mail écrit directement au demandeur.</p>
  </body>
</html>`;

  return { subject, text, html };
}
