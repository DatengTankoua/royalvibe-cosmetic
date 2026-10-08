import Link from "next/link";
import { MailLink } from "@/components/legal/mail-link";
import { OPERATOR, PROVIDERS, SITE } from "@/lib/legal/site-identity";

// 1-16C — Accord de traitement des données (loi 2024/017, art. 16, 20, 24
// à 27, 29, 30 et 32). Justifié par les rôles constatés : le commerce
// décide de l'usage des données qu'il saisit (produits, ventes, acheteurs,
// activité des membres) ; Stock Master les traite pour son compte. Les
// engagements opérationnels non encore définis sont signalés, jamais
// promis.
import type { DocumentContent } from "@/i18n/documents/types";

// 1-16G : texte français déplacé tel quel depuis la page (le texte
// affiché, archivé et accepté ne change pas).
const content: DocumentContent = {
  metaTitle: "Accord de traitement des données",
  metaDescription:
    "Engagements de Stock Master lorsqu'il traite, pour le compte d'un commerce, les données que ce commerce enregistre.",
  title: "Accord de traitement des données",
  intro: (
    <p>
      Quand votre commerce enregistre des informations dans {SITE.name}
      (ventes, acheteurs, membres, photos), votre commerce décide de leur usage
      et {SITE.name} les traite pour son compte. La loi n° 2024/017 exige alors
      un contrat entre les deux (art. 30). Cet accord en fixe le contenu.
    </p>
  ),
  sections: [
    {
      id: "parties",
      title: "Parties et rôles",
      content: (
        <ul>
          <li>
            <strong>Le commerce</strong> client de {SITE.name}, représenté par
            son propriétaire, est responsable du traitement des données
            qu&apos;il enregistre.
          </li>
          <li>
            <strong>L&apos;exploitant de {SITE.name}</strong> (
            {OPERATOR.legalName}) est sous-traitant pour ces données.
          </li>
          <li>
            Pour les données de compte (nom, e-mail, mot de passe, abonnement,
            notifications, demandes d&apos;assistance), l&apos;exploitant est
            responsable du traitement : la{" "}
            <Link href="/confidentialite">politique de confidentialité</Link>{" "}
            s&apos;applique.
          </li>
        </ul>
      ),
    },
    {
      id: "objet",
      title: "Données et personnes concernées",
      content: (
        <table>
          <caption className="sr-only">
            Données traitées pour le commerce
          </caption>
          <thead>
            <tr>
              <th scope="col">Personnes</th>
              <th scope="col">Données</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Acheteurs du commerce</td>
              <td>
                Nom et contact, seulement si le commerce les saisit dans une
                vente
              </td>
            </tr>
            <tr>
              <td>Membres du commerce</td>
              <td>
                Ventes enregistrées par chacun, actions sur le catalogue et le
                stock (historique), classements dans les analyses
              </td>
            </tr>
            <tr>
              <td>Toute personne visible sur une image</td>
              <td>Photos de produits et logo déposés par le commerce</td>
            </tr>
          </tbody>
        </table>
      ),
    },
    {
      id: "instructions",
      title: "Traitement sur instructions",
      content: (
        <>
          <p>
            {SITE.name} traite ces données uniquement pour fournir le service au
            commerce : enregistrer, afficher, calculer les analyses,
            synchroniser les ventes saisies sans connexion et envoyer les
            notifications choisies. Les réglages faits dans l&apos;application
            (membres, droits, notifications, suppressions) valent instructions
            du commerce.
          </p>
          <p>
            {SITE.name} n&apos;utilise pas ces données pour ses propres besoins,
            ne les vend pas et ne les communique pas à d&apos;autres commerces.
            Si une instruction paraît contraire à la loi, {SITE.name} en informe
            le commerce.
          </p>
        </>
      ),
    },
    {
      id: "confidentialite",
      title: "Confidentialité",
      content: (
        <p>
          Seules les personnes qui agissent pour {SITE.name} et qui en ont
          besoin pour le service doivent accéder à ces données, sur ses
          instructions (art. 24).
          {/* À COMPLÉTER : liste des personnes habilitées et engagement
              écrit de confidentialité. */}
        </p>
      ),
    },
    {
      id: "securite",
      title: "Sécurité",
      content: (
        <>
          <p>Mesures en place aujourd&apos;hui :</p>
          <ul>
            <li>
              séparation des données de chaque commerce, vérifiée par le serveur
              à chaque demande ;
            </li>
            <li>
              droits par membre, définis par le commerce et contrôlés par le
              serveur ;
            </li>
            <li>
              mots de passe et liens sensibles hachés, liens à durée limitée ;
            </li>
            <li>historique des actions sur les produits et les ventes ;</li>
            <li>
              suppression du fichier image lors de la suppression définitive
              d&apos;un produit.
            </li>
          </ul>
          {/* À COMPLÉTER : sauvegardes, chiffrement des données stockées
              et reprise après incident, tels que configurés chez les
              hébergeurs. */}
        </>
      ),
    },
    {
      id: "sous-traitants",
      title: "Sous-traitants ultérieurs",
      content: (
        <>
          <p>
            Le commerce autorise {SITE.name} à recourir aux prestataires
            suivants pour héberger le service et envoyer ses e-mails :
          </p>
          <ul>
            {PROVIDERS.map((p) => (
              <li key={p.name}>
                <span translate="no">{p.name}</span> : {p.role.toLowerCase()}
                {/* À AJOUTER : pays, une fois vérifié. */}
              </li>
            ))}
          </ul>
          {/* À COMPLÉTER : contrats et garanties des prestataires ;
              autorisation des transferts hors du Cameroun (loi 2024/017,
              art. 32) ; préavis et possibilité d'objection avant l'ajout ou le
              changement d'un prestataire. */}
        </>
      ),
    },
    {
      id: "incidents",
      title: "Incidents de sécurité",
      content: (
        <p>
          En cas de violation de données touchant le commerce, {SITE.name}{" "}
          l&apos;informe sans délai, avec ce qu&apos;il sait de l&apos;incident,
          pour lui permettre de remplir ses propres obligations (art. 22).
          {/* À COMPLÉTER : délai maximal, canal et contenu de la
              notification. */}
        </p>
      ),
    },
    {
      id: "assistance",
      title: "Aide au commerce",
      content: (
        <>
          <p>
            {SITE.name} aide le commerce à répondre aux personnes qui exercent
            leurs droits (accès, correction, effacement) sur des données
            qu&apos;il a enregistrées. La demande se fait à{" "}
            <MailLink to="privacy" />.
          </p>
          <p>
            Dans l&apos;application, le commerce peut déjà corriger ou supprimer
            une vente, retirer l&apos;accès d&apos;un membre et supprimer
            définitivement un produit et sa photo.
          </p>
          {/* À COMPLÉTER : délai et coût éventuel de cette aide ;
              participation à une analyse d'impact (art. 33). */}
        </>
      ),
    },
    {
      id: "fin",
      title: "Restitution et suppression",
      content: (
        <>
          <p>
            L&apos;application ne propose pas encore d&apos;export complet des
            données d&apos;un commerce, ni de suppression d&apos;un commerce par
            son propriétaire. Le propriétaire et l&apos;administrateur peuvent
            télécharger l&apos;historique des ventes de chaque mois (Excel ou
            PDF) depuis Analyse.
          </p>
          {/* À COMPLÉTER : à la fin du service, format et délai de
              restitution, puis suppression des données et des sauvegardes. */}
        </>
      ),
    },
    {
      id: "documentation",
      title: "Documentation et contrôle",
      content: (
        <p>
          La loi impose à {SITE.name} de tenir un registre des traitements (art.
          29), à présenter à l&apos;Autorité.
          {/* À COMPLÉTER : état du registre et modalités de contrôle par
              le commerce. */}
        </p>
      ),
    },
    // À COMPLÉTER avant de proposer l'accord aux commerces : identité
    // complète et signature ; pays d'hébergement, contrats et
    // autorisation des transferts ; délai de notification d'incident ;
    // sauvegardes et reprise ; export complet et suppression d'un
    // commerce ; délai de réponse aux demandes ; engagement de
    // confidentialité ; registre des traitements.
  ],
};

export default content;
