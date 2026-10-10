import type { AppLocale } from '../common/i18n/locale';

/**
 * 1-19A — Actions d'écriture DÉLÉGABLES annoncées au propriétaire quand un
 * AUTRE membre les réussit (inventaire : rapport 1-19A §4).
 *
 * Exclues volontairement :
 * - consultations (aucune écriture) ;
 * - création de vente (`sale-created`, déjà notifiée) et adhésion
 *   (`member-joined`) : jamais en double ;
 * - `support.contact` (message au service client, aucune donnée de
 *   l'organisation modifiée) ;
 * - opérations réservées au propriétaire (transfert de propriété, paiement) :
 *   l'auteur est alors toujours le destinataire.
 */
export enum MemberActivityEntity {
  PRODUCT = 'product',
  SECTION = 'section',
  SALE = 'sale',
  INVITATION = 'invitation',
  MEMBER = 'member',
  BRANDING = 'branding',
}

export enum MemberActivityAction {
  CREATED = 'created',
  UPDATED = 'updated',
  TRASHED = 'trashed',
  RESTORED = 'restored',
  PURGED = 'purged',
  CANCELLED = 'cancelled',
  REVOKED = 'revoked',
}

/** Longueur maximale d'un nom de cible figé dans l'événement. */
export const MEMBER_ACTIVITY_TARGET_NAME_MAX = 120;
/** Longueur maximale du nom de l'auteur figé dans la notification. */
export const MEMBER_ACTIVITY_ACTOR_NAME_MAX = 100;
/** Fenêtre FIXE de regroupement (même principe que le digest des ventes). */
export const MEMBER_ACTIVITY_WINDOW_MS = 60_000;

/** Cible figée au moment de l'action (lisible même après suppression). */
export interface MemberActivityTarget {
  id: string | null;
  name: string | null;
}

export function snapshotName(
  value: string | null | undefined,
  max: number = MEMBER_ACTIVITY_TARGET_NAME_MAX,
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** Clé du regroupement : même auteur, action et type de cible, même fenêtre. */
export function memberActivityGroupKey(input: {
  organizationId: string;
  actorId: string;
  entity: MemberActivityEntity;
  action: MemberActivityAction;
  eventAt: Date;
}): string {
  const windowStart =
    Math.floor(input.eventAt.getTime() / MEMBER_ACTIVITY_WINDOW_MS) *
    MEMBER_ACTIVITY_WINDOW_MS;
  return `member-activity:${input.organizationId}:${input.actorId}:${input.entity}:${input.action}:${windowStart}`;
}

const ENTITY_FR: Record<
  MemberActivityEntity,
  { one: string; many: string; the: string }
> = {
  [MemberActivityEntity.PRODUCT]: {
    one: 'le produit',
    many: 'produits',
    the: 'un produit',
  },
  [MemberActivityEntity.SECTION]: {
    one: 'la section',
    many: 'sections',
    the: 'une section',
  },
  [MemberActivityEntity.SALE]: {
    one: 'une vente de',
    many: 'ventes',
    the: 'une vente',
  },
  [MemberActivityEntity.INVITATION]: {
    one: "l'invitation de",
    many: 'invitations',
    the: 'une invitation',
  },
  [MemberActivityEntity.MEMBER]: {
    one: 'le membre',
    many: 'membres',
    the: 'un membre',
  },
  [MemberActivityEntity.BRANDING]: {
    one: "l'identité visuelle",
    many: "fois l'identité visuelle",
    the: "l'identité visuelle",
  },
};

const ENTITY_EN: Record<
  MemberActivityEntity,
  { one: string; many: string; the: string }
> = {
  [MemberActivityEntity.PRODUCT]: {
    one: 'product',
    many: 'products',
    the: 'a product',
  },
  [MemberActivityEntity.SECTION]: {
    one: 'section',
    many: 'sections',
    the: 'a section',
  },
  [MemberActivityEntity.SALE]: {
    one: 'a sale of',
    many: 'sales',
    the: 'a sale',
  },
  [MemberActivityEntity.INVITATION]: {
    one: 'the invitation for',
    many: 'invitations',
    the: 'an invitation',
  },
  [MemberActivityEntity.MEMBER]: {
    one: 'member',
    many: 'members',
    the: 'a member',
  },
  [MemberActivityEntity.BRANDING]: {
    one: 'the branding',
    many: 'branding changes',
    the: 'the branding',
  },
};

const ACTION_FR: Record<MemberActivityAction, string> = {
  [MemberActivityAction.CREATED]: 'a créé',
  [MemberActivityAction.UPDATED]: 'a modifié',
  [MemberActivityAction.TRASHED]: 'a mis à la corbeille',
  [MemberActivityAction.RESTORED]: 'a restauré',
  [MemberActivityAction.PURGED]: 'a supprimé définitivement',
  [MemberActivityAction.CANCELLED]: 'a annulé',
  [MemberActivityAction.REVOKED]: 'a révoqué',
};

const ACTION_EN: Record<MemberActivityAction, string> = {
  [MemberActivityAction.CREATED]: 'created',
  [MemberActivityAction.UPDATED]: 'updated',
  [MemberActivityAction.TRASHED]: 'moved to the trash',
  [MemberActivityAction.RESTORED]: 'restored',
  [MemberActivityAction.PURGED]: 'permanently deleted',
  [MemberActivityAction.CANCELLED]: 'cancelled',
  [MemberActivityAction.REVOKED]: 'revoked',
};

/**
 * Phrase du centre : auteur, action, cible (nom figé), ou le nombre de cibles
 * pour une action groupée. Jamais de montant ni d'identifiant.
 */
export function memberActivitySentence(
  input: {
    actorName: string | null;
    action: MemberActivityAction;
    entity: MemberActivityEntity;
    count: number;
    targets: readonly MemberActivityTarget[];
  },
  locale: AppLocale = 'fr',
): string {
  const en = locale === 'en';
  const actor = input.actorName ?? (en ? 'A team member' : 'Un collaborateur');
  const verb = (en ? ACTION_EN : ACTION_FR)[input.action];
  const entity = (en ? ENTITY_EN : ENTITY_FR)[input.entity];
  const distinct = input.targets.length;
  if (input.entity === MemberActivityEntity.BRANDING) {
    return `${actor} ${verb} ${entity.the}.`;
  }
  if (distinct > 1) {
    return `${actor} ${verb} ${distinct} ${entity.many}.`;
  }
  const name = input.targets[0]?.name;
  if (!name) return `${actor} ${verb} ${entity.the}.`;
  const times =
    input.count > 1
      ? en
        ? ` (${input.count}×)`
        : ` (${input.count} fois)`
      : '';
  return en
    ? `${actor} ${verb} ${entity.one} “${name}”${times}.`
    : `${actor} ${verb} ${entity.one} « ${name} »${times}.`;
}

export function memberJoinedSentence(
  memberName: string | null,
  locale: AppLocale = 'fr',
): string {
  if (locale === 'en') {
    return memberName
      ? `${memberName} joined your business.`
      : 'A new member joined your business.';
  }
  return memberName
    ? `${memberName} a rejoint votre entreprise.`
    : 'Un nouveau membre a rejoint votre entreprise.';
}
