import Link from "next/link";
import { DocumentPage } from "@/components/legal/document-page";
import { MailLink } from "@/components/legal/mail-link";
import { documentMetadata } from "@/lib/legal/document-metadata";
import {
  LOCATIONS,
  OPERATOR,
  PROVIDERS,
  SITE,
  legalDocument,
} from "@/lib/legal/site-identity";

// 1-16C — Politique de confidentialité, rédigée d'après l'audit du code
// (schémas API, stockages navigateur, prestataires documentés) et la loi
// 2024/017 du 23 décembre 2024 (art. 9, 13, 21, 22, 27, 32, 37 à 47).
// La loi pose le consentement comme principe (art. 9 (1)) et ne prévoit que
// trois dérogations (obligation légale, mission d'intérêt public, santé) :
// aucun « consentement global » ni base « contrat » n'est affirmé ici ; les
// fondements indiqués sont des propositions à valider.
const doc = legalDocument("/confidentialite");

export const metadata = documentMetadata(
  "Politique de confidentialité",
  "Données traitées par Stock Master, finalités, destinataires, conservation, sécurité et droits des personnes.",
  doc,
);

export default function ConfidentialitePage() {
  return (
    <DocumentPage
      title="Politique de confidentialité"
      doc={doc}
      intro={
        <p>
          Cette page explique quelles données {SITE.name} traite, pourquoi, avec
          qui elles sont partagées, combien de temps elles sont conservées et
          comment exercer vos droits. Elle distingue les données de votre
          compte, gérées par {SITE.name}, et les données que votre commerce
          enregistre dans l&apos;application, traitées pour son compte.
        </p>
      }
      sections={[
        {
          id: "responsables",
          title: "Qui est responsable de vos données",
          content: (
            <>
              <h3>Les données de votre compte</h3>
              <p>
                Pour les comptes, les abonnements, les notifications et la
                sécurité du service, le responsable du traitement est
                l&apos;exploitant de {SITE.name} : {OPERATOR.legalName},
                entreprise établie au {SITE.country} (implantations :{" "}
                {LOCATIONS.join(" ; ")}).
              </p>
              <h3>Les données saisies par un commerce</h3>
              <p>
                Pour les produits, le stock, les ventes, les photos et les
                informations sur les acheteurs qu&apos;un commerce enregistre,
                c&apos;est le <strong>commerce</strong> qui décide de leur usage
                : il en est responsable. {SITE.name} les traite pour son compte,
                en sous-traitant, selon l&apos;
                <Link href="/traitement-donnees">
                  accord de traitement des données
                </Link>
                .
              </p>
              <h3>Contact pour vos données</h3>
              <p>
                <MailLink to="privacy" />.
                {/* À COMPLÉTER : désignation éventuelle d'un délégué à la
                protection des données. */}
              </p>
            </>
          ),
        },
        {
          id: "donnees",
          title: "Les données traitées",
          content: (
            <>
              <h3>Compte et connexion</h3>
              <ul>
                <li>
                  nom, adresse e-mail, date de confirmation de l&apos;adresse ;
                </li>
                <li>
                  mot de passe, conservé uniquement sous forme hachée (jamais en
                  clair) ;
                </li>
                <li>
                  liens de confirmation et de réinitialisation, conservés sous
                  forme hachée, avec leurs dates d&apos;envoi et
                  d&apos;expiration et le nombre d&apos;envois récents.
                </li>
              </ul>
              <h3>Acceptation des conditions</h3>
              <ul>
                <li>
                  identifiant de votre compte et, s&apos;il y a lieu, du
                  commerce concerné ;
                </li>
                <li>
                  date et heure de l&apos;acceptation, fixées par le serveur ;
                </li>
                <li>
                  langue, versions et empreintes numériques des textes acceptés
                  et de cette politique telle qu&apos;elle vous a été présentée.
                </li>
              </ul>
              <p>
                Lire cette politique ne vaut pas accord : elle vous informe.
                Aucune autorisation facultative (par exemple pour des messages
                commerciaux) n&apos;est demandée à l&apos;inscription, et
                l&apos;activation des notifications sur un appareil reste un
                choix séparé.
              </p>
              <h3>Commerce et membres</h3>
              <ul>
                <li>nom du commerce, logo, couleur, devise, état ;</li>
                <li>
                  pour chaque membre : rôle, droits, état de l&apos;accès,
                  auteur de l&apos;invitation, date d&apos;arrivée ;
                </li>
                <li>
                  invitations : adresse e-mail invitée, rôle et droits proposés,
                  état, date d&apos;expiration.
                </li>
              </ul>
              <h3>Abonnement</h3>
              <ul>
                <li>
                  périodes d&apos;essai et d&apos;abonnement : durée, dates,
                  origine ;
                </li>
                <li>
                  montant, durée choisie, références de l&apos;opération, état,
                  et numéro de téléphone du payeur sous forme masquée.
                </li>
              </ul>
              <h3>Notifications</h3>
              <ul>
                <li>
                  notifications de l&apos;application : type, date, lecture ;
                </li>
                <li>
                  vos choix de catégories de notifications, par commerce ;
                </li>
                <li>
                  si vous activez les notifications sur un appareil :
                  l&apos;adresse technique et les clés fournies par le
                  navigateur pour cet appareil.
                </li>
              </ul>
              <h3>Demandes d&apos;assistance</h3>
              <ul>
                <li>
                  depuis Organisation, puis Assistance : catégorie, sujet et
                  message que vous écrivez ;
                </li>
                <li>
                  joints automatiquement par le serveur : votre nom et votre
                  adresse e-mail, le nom et l&apos;identifiant du commerce,
                  votre rôle et vos droits, les identifiants de votre compte et
                  de votre appartenance, la date, une référence de demande et,
                  si elle est connue, la page de l&apos;application concernée.
                  Aucune vente, aucun contact d&apos;acheteur, aucun fichier,
                  mot de passe ni jeton n&apos;est joint.
                </li>
              </ul>
              <h3>Données saisies par le commerce</h3>
              <ul>
                <li>catégories, produits, prix, quantités, photos ;</li>
                <li>
                  ventes : produit, quantité, prix, date, membre qui l&apos;a
                  enregistrée et, si le commerce les saisit, nom et contact de
                  l&apos;acheteur ;
                </li>
                <li>
                  historique des actions (qui a modifié quoi et quand) et bilans
                  mensuels calculés.
                </li>
              </ul>
              <h3>Données techniques</h3>
              <ul>
                <li>
                  adresse IP : utilisée pour limiter les tentatives de connexion
                  répétées. Ces compteurs sont gardés en mémoire et
                  disparaissent au redémarrage du serveur ;
                </li>
                {/* À COMPLÉTER : contenu et durée des journaux techniques de
                chaque hébergeur. */}
              </ul>
              <p>
                Ce que l&apos;application garde sur votre appareil est décrit
                sur la page{" "}
                <Link href="/cookies">
                  Cookies et stockage sur l&apos;appareil
                </Link>
                .
              </p>
            </>
          ),
        },
        {
          id: "finalites",
          title: "Pourquoi ces données sont traitées",
          content: (
            <>
              <p>
                La loi n° 2024/017 fait du consentement préalable, libre,
                éclairé et spécifique la règle (art. 9). Elle prévoit des
                exceptions, notamment le respect d&apos;une obligation légale.
                Chaque usage ci-dessous a donc son propre fondement : aucun
                accord global ne couvre tous les usages.
              </p>
              <table>
                <caption className="sr-only">Finalités et fondements</caption>
                <thead>
                  <tr>
                    <th scope="col">Usage</th>
                    <th scope="col">Fondement envisagé</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      Créer et gérer votre compte, vous connecter, envoyer les
                      e-mails de confirmation et de réinitialisation
                    </td>
                    <td>
                      Votre consentement
                      {/* À VALIDER par un juriste (1-16C.2) : la case
                      d'inscription porte sur l'acceptation des CONDITIONS ;
                      elle n'est pas présentée comme le consentement de
                      l'art. 9 au traitement des données du compte. Forme et
                      preuve de ce consentement (case distincte ou autre
                      fondement) à décider ; ne pas les confondre. */}
                    </td>
                  </tr>
                  <tr>
                    <td>
                      Conserver la preuve de votre acceptation des conditions
                    </td>
                    <td>
                      Obligation légale : la preuve de l&apos;information et de
                      l&apos;acceptation incombe au prestataire (loi n°
                      2010/021, art. 26 ; décret n° 2011/1521/PM, art. 12).
                      {/* À VALIDER par un juriste. */}
                    </td>
                  </tr>
                  <tr>
                    <td>
                      Faire fonctionner le commerce : membres, droits,
                      catalogue, ventes, analyses
                    </td>
                    <td>
                      Traitement pour le compte du commerce, sur ses
                      instructions (accord de traitement)
                    </td>
                  </tr>
                  <tr>
                    <td>
                      Gérer l&apos;essai et l&apos;abonnement, conserver la
                      preuve des opérations
                    </td>
                    <td>
                      Consentement du propriétaire ; obligation légale de
                      conserver certaines opérations (décret n° 2011/1521/PM,
                      art. 8 et 22).
                      {/* À VALIDER par un juriste. */}
                    </td>
                  </tr>
                  <tr>
                    <td>
                      Sécuriser le service : limiter les abus, tracer les
                      actions sur les données
                    </td>
                    <td>
                      Obligation légale de sécurité (loi n° 2024/017, art. 27).
                      {/* À VALIDER par un juriste. */}
                    </td>
                  </tr>
                  <tr>
                    <td>Répondre à vos demandes d&apos;assistance</td>
                    <td>
                      Votre consentement : vous choisissez d&apos;écrire au
                      service client
                      {/* À VALIDER par un juriste. */}
                    </td>
                  </tr>
                  <tr>
                    <td>
                      Vous prévenir sur votre appareil (notifications push)
                    </td>
                    <td>
                      Votre consentement spécifique : activation par vous et
                      autorisation du navigateur. Il se retire à tout moment.
                    </td>
                  </tr>
                </tbody>
              </table>
              <p>
                {SITE.name} n&apos;envoie pas de prospection commerciale, ne
                vend pas vos données et n&apos;affiche pas de publicité. Les
                analyses (chiffre d&apos;affaires, classements de produits et de
                vendeurs) sont des calculs faits à partir des ventes, pour le
                commerce qui les consulte.
              </p>
            </>
          ),
        },
        {
          id: "destinataires",
          title: "Qui peut voir les données",
          content: (
            <>
              <ul>
                <li>
                  <strong>Les membres de votre commerce</strong>, selon les
                  droits que le commerce leur a donnés. Un vendeur sans droit
                  supplémentaire ne voit que ses propres ventes.
                </li>
                <li>
                  <strong>Les prestataires techniques</strong> qui hébergent le
                  service ou envoient ses e-mails, uniquement pour ce service
                  (liste ci-dessous).
                </li>
                <li>
                  <strong>Le service de notification du navigateur</strong> (par
                  exemple celui de Google, Mozilla ou Apple), si vous activez
                  les notifications sur un appareil : il achemine le message
                  vers cet appareil.
                </li>
                <li>
                  <strong>Le service client de {SITE.name}</strong>, pour vos
                  demandes d&apos;assistance : le message est envoyé par Resend
                  à l&apos;adresse <MailLink to="support" />. Sa réponse vous
                  parvient à l&apos;adresse e-mail de votre compte.
                </li>
                <li>
                  <strong>Une autorité</strong>, lorsque la loi l&apos;exige.
                </li>
              </ul>
              <table>
                <caption className="sr-only">Prestataires techniques</caption>
                <thead>
                  <tr>
                    <th scope="col">Prestataire</th>
                    <th scope="col">Rôle</th>
                  </tr>
                </thead>
                <tbody>
                  {PROVIDERS.map((p) => (
                    <tr key={p.name}>
                      <td translate="no">{p.name}</td>
                      <td>{p.role}</td>
                      {/* À AJOUTER : pays et région, une fois vérifiés. */}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ),
        },
        {
          id: "transferts",
          title: "Données hébergées hors du Cameroun",
          content: (
            <>
              <p>
                Les prestataires listés ci-dessus sont des entreprises
                étrangères. Vos données peuvent donc être hébergées ou
                transmises hors du Cameroun. Les pays concernés seront indiqués
                dès qu&apos;ils auront été vérifiés.
              </p>
              <p>
                La loi n° 2024/017 soumet tout transfert de données vers un État
                étranger à l&apos;autorisation préalable de l&apos;Autorité de
                protection des données à caractère personnel (art. 32).
                {/* À COMPLÉTER : état de la démarche (autorisation obtenue,
                demandée ou impossible à ce jour, avec sa date). */}
              </p>
            </>
          ),
        },
        {
          id: "conservation",
          title: "Combien de temps les données sont gardées",
          content: (
            <>
              <table>
                <caption className="sr-only">Durées de conservation</caption>
                <thead>
                  <tr>
                    <th scope="col">Données</th>
                    <th scope="col">Durée</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Lien de confirmation d&apos;adresse e-mail</td>
                    <td>Valable 24 heures</td>
                  </tr>
                  <tr>
                    <td>Lien de réinitialisation du mot de passe</td>
                    <td>Valable 1 heure</td>
                  </tr>
                  <tr>
                    <td>Lien d&apos;invitation</td>
                    <td>
                      Valable 72 heures ; l&apos;invitation reste ensuite dans
                      l&apos;historique du commerce.
                      {/* À COMPLÉTER : durée de conservation de l'historique. */}
                    </td>
                  </tr>
                  <tr>
                    <td>Connexion sur un appareil</td>
                    <td>7 jours au plus, ou jusqu&apos;à la déconnexion</td>
                  </tr>
                  <tr>
                    <td>
                      Registre d&apos;une demande d&apos;assistance (référence,
                      contexte joint, état de l&apos;envoi ; ni le sujet ni le
                      message)
                    </td>
                    <td>
                      Expire 30 jours après la demande. Il est ensuite effacé
                      par un nettoyage automatique de la base, qui
                      s&apos;exécute en arrière-plan et peut intervenir un peu
                      plus tard. Le message reçu par le service client est
                      conservé séparément, dans sa messagerie (ligne suivante).
                      {/* Index TTL créé par `pnpm --filter api
                      migrate:support-request-indexes`, à exécuter avant
                      l'activation de cette version (README, Déploiement). */}
                    </td>
                  </tr>
                  <tr>
                    <td>
                      Message d&apos;assistance reçu par le service client
                    </td>
                    <td>
                      Conservé dans la messagerie du service client
                      {/* À COMPLÉTER : durée de conservation dans la
                      messagerie support. */}
                    </td>
                  </tr>
                  <tr>
                    <td>Notifications lues</td>
                    <td>
                      Supprimées de 48 heures à 30 jours après la lecture, selon
                      leur type
                    </td>
                  </tr>
                  {/* À COMPLÉTER : durée maximale des notifications non lues. */}
                  <tr>
                    <td>Notifications sur un appareil</td>
                    <td>
                      Jusqu&apos;à leur désactivation. Un appareil devenu
                      injoignable est désactivé automatiquement.
                      {/* À COMPLÉTER : durée après désactivation. */}
                    </td>
                  </tr>
                  <tr>
                    <td>Compte</td>
                    <td>
                      Tant que le compte existe.
                      {/* À COMPLÉTER : durée après une demande de suppression. */}
                    </td>
                  </tr>
                  <tr>
                    <td>
                      Preuve d&apos;acceptation des conditions et textes
                      acceptés
                    </td>
                    <td>
                      Conservés tant que le compte existe. Rien n&apos;est
                      supprimé automatiquement aujourd&apos;hui.
                      {/* À COMPLÉTER (1-16C.2) : durée après la fin du compte ou
                      du commerce (10 ans envisagés pour un contrat d'au moins
                      20 000 FCFA, décret 2011/1521/PM art. 8 ; à valider). */}
                    </td>
                  </tr>
                  <tr>
                    <td>
                      Données du commerce, ventes et historique des actions
                    </td>
                    <td>
                      Tant que le commerce utilise le service. Rien n&apos;est
                      supprimé automatiquement aujourd&apos;hui.
                      {/* À COMPLÉTER : durée après la fin du service. */}
                    </td>
                  </tr>
                  <tr>
                    <td>
                      Opérations d&apos;abonnement d&apos;au moins 20 000 FCFA
                    </td>
                    <td>
                      10 ans, durée prévue par le décret n° 2011/1521/PM (art.
                      8).
                      {/* À VALIDER par un juriste. */}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p>
                La loi n° 2024/017 prévoit que les durées maximales soient
                fixées par un référentiel de l&apos;Autorité (art. 13 et 28).
                Elles seront ajustées lorsque ce référentiel sera publié.
              </p>
            </>
          ),
        },
        {
          id: "securite",
          title: "Comment les données sont protégées",
          content: (
            <ul>
              <li>
                mots de passe et liens sensibles enregistrés sous forme hachée ;
              </li>
              <li>
                liens de confirmation, de réinitialisation et d&apos;invitation
                à durée limitée ;
              </li>
              <li>
                données de chaque commerce séparées : chaque demande est
                vérifiée par le serveur pour le commerce et les droits du membre
                ;
              </li>
              <li>limitation des tentatives de connexion répétées ;</li>
              <li>
                sur l&apos;appareil, données hors connexion effacées à la
                déconnexion (sauf les ventes pas encore envoyées).
              </li>
            </ul>
          ),
        },
        {
          id: "violation",
          title: "En cas d'incident",
          content: (
            <p>
              Si une violation de données est constatée, la loi n° 2024/017
              impose d&apos;en informer sans délai l&apos;Autorité et les
              personnes concernées (art. 22).
              {/* À COMPLÉTER : procédure interne de gestion des incidents et
              personne chargée de l'information. */}
            </p>
          ),
        },
        {
          id: "droits",
          title: "Vos droits",
          content: (
            <>
              <p>La loi n° 2024/017 vous permet notamment de demander :</p>
              <ul>
                <li>l&apos;accès à vos données et une copie (art. 39) ;</li>
                <li>
                  la correction de données inexactes ou incomplètes (art. 42) ;
                </li>
                <li>
                  l&apos;effacement de vos données ou l&apos;arrêt de leur
                  diffusion (art. 37 et 38) ;
                </li>
                <li>
                  la limitation du traitement si l&apos;exactitude ou
                  l&apos;usage est contesté (art. 46) ;
                </li>
                <li>
                  de vous opposer à un traitement, dans les cas prévus par la
                  loi (art. 40) ;
                </li>
                <li>
                  la récupération des données que vous avez fournies, dans un
                  format lisible par machine (art. 43) ;
                </li>
                <li>
                  de donner des directives pour vos données après votre décès
                  (art. 21 et 45).
                </li>
              </ul>
              <p>
                Pour exercer ces droits, écrivez à{" "}
                <MailLink
                  to="privacy"
                  subject="Demande concernant mes données"
                />{" "}
                depuis l&apos;adresse de votre compte. La loi demande de pouvoir
                justifier de votre identité (art. 42) : il peut vous être
                demandé de confirmer votre demande depuis cette adresse.
              </p>
              <p>
                L&apos;application ne propose pas encore de bouton pour
                télécharger vos données ou supprimer votre compte : ces demandes
                sont traitées par e-mail.
                {/* À COMPLÉTER : délai de réponse interne, en attendant le
                délai réglementaire (art. 47). */}
              </p>
              <p>
                Pour des données qu&apos;un commerce a enregistrées sur vous,
                par exemple comme acheteur, adressez-vous d&apos;abord à ce
                commerce. {SITE.name} l&apos;aide à vous répondre.
              </p>
              <p>
                Vous pouvez aussi saisir l&apos;Autorité de protection des
                données à caractère personnel (art. 53).
                {/* À AJOUTER : coordonnées de l'Autorité dès qu'elle est
                opérationnelle. */}
              </p>
            </>
          ),
        },
        {
          id: "mineurs",
          title: "Mineurs",
          content: (
            <p>
              {SITE.name} s&apos;adresse aux commerces. Selon la loi n°
              2024/017, le consentement d&apos;une personne de moins de 18 ans
              n&apos;est valable qu&apos;avec celui de ses parents ou de son
              représentant légal (art. 9).
              {/* À COMPLÉTER : âge minimum retenu et vérification. */}
            </p>
          ),
        },
        {
          id: "modifications",
          title: "Modifications de cette politique",
          content: (
            <p>
              Chaque version est datée en haut de la page.
              {/* À COMPLÉTER : annonce des modifications importantes (canal et
              délai). */}
            </p>
          ),
        },
      ]}
    />
  );
}
