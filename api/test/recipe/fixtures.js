/**
 * 1-14D.2H — Comptes FICTIFS de la recette (domaine réservé `.local`).
 * Mot de passe commun : `PASSWORD` de `recipe-common.js`.
 *
 * - `owner` : inscription réelle (`AuthService.register`) avec essai ;
 * - `invitedBy` : invitation puis acceptation réelles (services de l'API) ;
 * - `expired` : périodes déplacées dans le passé (session limitée `/access`).
 */
'use strict';

const ACCOUNTS = Object.freeze([
  {
    key: 'ownerActive',
    email: 'proprietaire.actif@recette.local',
    name: 'Propriétaire Actif',
    organization: 'Boutique Active',
    role: 'owner',
    use: 'Propriétaire actif (/app) : paiement, réponse perdue, échec puis nouvel essai',
  },
  {
    key: 'adminActive',
    email: 'admin.actif@recette.local',
    name: 'Admin Actif',
    invitedBy: 'ownerActive',
    role: 'admin',
    use: 'Admin : aucun parcours de paiement',
  },
  {
    key: 'sellerActive',
    email: 'vendeur.actif@recette.local',
    name: 'Vendeur Actif',
    invitedBy: 'ownerActive',
    role: 'seller',
    use: 'Vendeur : aucun parcours de paiement',
  },
  {
    key: 'ownerLimited',
    email: 'proprietaire.limite@recette.local',
    name: 'Propriétaire Limité',
    organization: 'Boutique Limitée',
    role: 'owner',
    expired: true,
    use: 'Propriétaire en session limitée (/access) : paiement et récupération de l’accès',
  },
  {
    key: 'sellerLimited',
    email: 'vendeur.limite@recette.local',
    name: 'Vendeur Limité',
    invitedBy: 'ownerLimited',
    role: 'seller',
    use: 'Vendeur d’un commerce expiré : aucun parcours',
  },
  {
    key: 'ownerWebhook',
    email: 'proprietaire.webhook@recette.local',
    name: 'Proprio Webhook',
    organization: 'Boutique Webhook',
    role: 'owner',
    expired: true,
    use: 'Webhook POST signé (mode campay), puis rejeu',
  },
  {
    key: 'ownerReconcile',
    email: 'proprietaire.rapprochement@recette.local',
    name: 'Proprio Rappro',
    organization: 'Rapprochement',
    role: 'owner',
    use: 'Initiation incertaine puis rapprochement simulé (mode campay)',
  },
  {
    key: 'ownerReview',
    email: 'proprietaire.revue@recette.local',
    name: 'Proprio Revue',
    organization: 'Boutique Revue',
    role: 'owner',
    use: 'Paiement en review puis rapprochement simulé (mode campay)',
  },
  {
    key: 'ownerSuspended',
    email: 'proprietaire.suspendu@recette.local',
    name: 'Proprio Suspendu',
    organization: 'Boutique Suspendue',
    role: 'owner',
    expired: true,
    use: 'Suspension prioritaire (recipe.js org suspend)',
  },
]);

// Contrôle statique des limites de l'API (20 caractères).
for (const account of ACCOUNTS) {
  if (
    account.name.length > 20 ||
    (account.organization && account.organization.length > 20)
  ) {
    throw new Error(`Fixture invalide : ${account.key}`);
  }
}

module.exports = { ACCOUNTS };
