import { createHash } from 'crypto';
import { PushCategory } from './schemas/push-category';
import { SubscriptionPeriodKind } from '../subscriptions/subscription-terms';

/**
 * 1-16A — Contenu des notifications. GÉNÉRIQUE par construction : visible sur
 * l'écran verrouillé (push) comme dans la liste du centre, il ne porte ni nom
 * de produit, ni quantité, ni montant, ni téléphone, ni référence, ni nom
 * d'organisation ou de vendeur. Le détail s'obtient en ouvrant l'application,
 * qui le relit avec les droits de la session courante.
 *
 * `url` : route INTERNE existante (chemin relatif, jamais une URL externe).
 * `tag` : identifiant stable (un même sujet remplace la notification
 * affichée au lieu d'en empiler une seconde).
 * `aud` : titulaire attendu (utilisateur, organisation), comparé par le
 * service worker à l'identité locale avant tout affichage. Le contenu est
 * chiffré de bout en bout (RFC 8291) : le service push ne le lit pas.
 */
export interface PushMessagePayload {
  v: 1;
  category: PushCategory;
  title: string;
  body: string;
  url: string;
  tag: string;
  aud: { u: string; o: string };
}

export interface PushMessageSubject {
  category: PushCategory;
  organizationId: string;
  productId: string | null;
  paymentId: string | null;
  periodKind: SubscriptionPeriodKind | null;
  /** 1-16A.1 : identifiants pour les liens du centre. */
  saleId?: string | null;
  reportId?: string | null;
  /** Clé de l'événement (tag des regroupements). */
  eventKey?: string;
}

export const NOTIFICATION_TITLE = 'Stock Master';

/** 1-16A.1 — Texte générique d'une catégorie (push et liste du centre). */
export function notificationBody(
  category: PushCategory,
  periodKind: SubscriptionPeriodKind | null = null,
): string {
  switch (category) {
    case PushCategory.STOCK_DEPLETED:
      return 'Un produit est en rupture de stock.';
    case PushCategory.STOCK_LOW:
      return 'Le stock d’un produit est presque épuisé.';
    case PushCategory.SALE_CREATED:
      return 'Nouvelle vente enregistrée.';
    case PushCategory.SALE_DIGEST:
      return 'De nouvelles ventes ont été enregistrées.';
    case PushCategory.SUBSCRIPTION_ENDING:
      return periodKind === SubscriptionPeriodKind.TRIAL
        ? "Votre période d'essai se termine bientôt."
        : 'Votre abonnement se termine bientôt.';
    case PushCategory.PAYMENT_SUCCEEDED:
      return 'Votre paiement a été confirmé.';
    case PushCategory.MONTHLY_REPORT:
      return 'Votre bilan mensuel est disponible.';
  }
}

/** Route interne ouverte par un clic sur le push. */
export function pushUrl(subject: PushMessageSubject): string {
  switch (subject.category) {
    case PushCategory.STOCK_DEPLETED:
    case PushCategory.STOCK_LOW:
      return `/app/catalog/products/${subject.productId}`;
    case PushCategory.SALE_CREATED:
    case PushCategory.SALE_DIGEST:
      return '/app/sales';
    case PushCategory.SUBSCRIPTION_ENDING:
    case PushCategory.PAYMENT_SUCCEEDED:
      return '/app/organization/subscription';
    case PushCategory.MONTHLY_REPORT:
      return '/app/notifications';
  }
}

function pushTag(subject: PushMessageSubject): string {
  switch (subject.category) {
    case PushCategory.STOCK_DEPLETED:
      return `stock-depleted:${subject.productId}`;
    case PushCategory.STOCK_LOW:
      return `stock-low:${subject.productId}`;
    case PushCategory.SALE_CREATED:
      return `sale-created:${subject.saleId}`;
    case PushCategory.SALE_DIGEST:
      // Un seul affichage « nouvelles ventes » par organisation : la fenêtre
      // suivante remplace la précédente au lieu de s'empiler.
      return `sale-digest:${subject.organizationId}`;
    case PushCategory.SUBSCRIPTION_ENDING:
      return `subscription-ending:${subject.organizationId}`;
    case PushCategory.PAYMENT_SUCCEEDED:
      return `payment-succeeded:${subject.paymentId}`;
    case PushCategory.MONTHLY_REPORT:
      return `monthly-report:${subject.reportId}`;
  }
}

export function buildPushMessage(
  subject: PushMessageSubject,
  recipient: { userId: string; organizationId: string },
): PushMessagePayload {
  return {
    v: 1,
    category: subject.category,
    title: NOTIFICATION_TITLE,
    body: notificationBody(subject.category, subject.periodKind),
    url: pushUrl(subject),
    tag: pushTag(subject),
    aud: { u: recipient.userId, o: recipient.organizationId },
  };
}

/**
 * En-tête `Topic` (RFC 8030 §5.4 : 32 caractères base64url au plus) dérivé du
 * tag : le service push remplace un message encore en attente de même sujet.
 */
export function pushTopic(tag: string): string {
  return createHash('sha256').update(tag).digest('base64url').slice(0, 32);
}
