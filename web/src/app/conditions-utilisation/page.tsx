import Link from "next/link";
import { DocumentPage } from "@/components/legal/document-page";
import { MailLink } from "@/components/legal/mail-link";
import { documentMetadata } from "@/lib/legal/document-metadata";
import { OPERATOR, SITE, legalDocument } from "@/lib/legal/site-identity";

// 1-16C — Conditions d'utilisation. Décrit uniquement les fonctions
// livrées. Aucune clause d'exonération ou de limitation de responsabilité,
// d'arbitrage ni de tribunal imposé (loi-cadre 2011/012, art. 5 et 35 ;
// décret 2011/1521/PM, art. 25-26) : points à faire valider par un juriste.
const doc = legalDocument("/conditions-utilisation");

export const metadata = documentMetadata(
  "Conditions d'utilisation",
  "Règles d'utilisation du service Stock Master : comptes, commerces, rôles, sécurité, disponibilité et suspension.",
  doc,
);

export default function ConditionsUtilisationPage() {
  return (
    <DocumentPage
      title="Conditions d'utilisation"
      doc={doc}
      intro={
        <p>
          Ces conditions expliquent comment utiliser {SITE.name}, ce que vous
          pouvez attendre du service et ce que l&apos;on attend de vous. Elles
          s&apos;appliquent à toute personne qui crée un compte ou rejoint un
          commerce. Les règles propres à l&apos;abonnement figurent dans les{" "}
          <Link href="/conditions-abonnement">
            conditions d&apos;abonnement
          </Link>
          .
        </p>
      }
      sections={[
        {
          id: "service",
          title: "Le service",
          content: (
            <>
              <p>
                {SITE.name} est une application en ligne de gestion du stock et
                des ventes, conçue pour les commerces et les petites
                entreprises. Elle s&apos;utilise dans le navigateur d&apos;un
                téléphone, d&apos;une tablette ou d&apos;un ordinateur. Elle
                permet notamment de :
              </p>
              <ul>
                <li>ranger ses produits par catégorie et suivre le stock ;</li>
                <li>
                  enregistrer des ventes, y compris sans connexion dans les
                  limites décrites dans le guide ;
                </li>
                <li>inviter des membres et choisir leurs droits ;</li>
                <li>consulter des analyses calculées à partir des ventes ;</li>
                <li>
                  recevoir des notifications dans l&apos;application et, si vous
                  l&apos;activez, sur l&apos;appareil.
                </li>
              </ul>
              <p>
                Le service est exploité par {OPERATOR.legalName}, entreprise
                établie au {SITE.country} (voir les{" "}
                <Link href="/mentions-legales">mentions légales</Link>).
              </p>
            </>
          ),
        },
        {
          id: "acces",
          title: "Qui peut utiliser Stock Master",
          content: (
            <>
              <p>
                {SITE.name} est destiné à un usage professionnel : gérer
                l&apos;activité d&apos;un commerce. Pour créer un compte, vous
                devez pouvoir vous engager pour vous-même ou pour le commerce
                que vous représentez.
              </p>
              {/* À COMPLÉTER : âge minimum pour créer un compte (loi
              2024/017, art. 9 (3) : accord des parents avant 18 ans). */}
              <p>
                Les inscriptions en ligne peuvent être fermées temporairement.
                Dans ce cas, seuls les comptes existants et les personnes
                invitées par un commerce peuvent accéder au service.
              </p>
            </>
          ),
        },
        {
          id: "compte",
          title: "Votre compte",
          content: (
            <>
              <ul>
                <li>
                  Vous fournissez un nom, une adresse e-mail que vous utilisez
                  réellement, et un mot de passe de 6 à 100 caractères.
                  Choisissez un mot de passe que vous n&apos;utilisez nulle part
                  ailleurs.
                </li>
                <li>
                  L&apos;adresse e-mail doit être confirmée avec le lien reçu
                  avant la première connexion. Ce lien est valable 24 heures.
                </li>
                <li>
                  Le compte est personnel : ne partagez pas vos identifiants.
                  Chaque vendeur doit avoir son propre compte, ce qui permet de
                  savoir qui a enregistré chaque vente.
                </li>
                <li>
                  Une connexion reste ouverte sur l&apos;appareil jusqu&apos;à
                  ce que vous vous déconnectiez ou qu&apos;elle expire (au plus
                  7 jours). Déconnectez-vous sur un appareil partagé.
                </li>
              </ul>
              <p>
                La modification du nom ou de l&apos;adresse e-mail et la
                suppression du compte ne sont pas encore proposées dans
                l&apos;application. Pour ces demandes, écrivez à{" "}
                <MailLink to="support" />.
              </p>
            </>
          ),
        },
        {
          id: "commerces",
          title: "Commerces, rôles et responsabilités",
          content: (
            <>
              <p>
                À l&apos;inscription, vous créez un commerce dont vous devenez
                le <strong>propriétaire</strong>. Dans chaque commerce, un
                membre a l&apos;un de ces rôles :
              </p>
              <ul>
                <li>
                  <strong>Propriétaire</strong> : tous les droits, dont
                  l&apos;abonnement et le transfert de la propriété à un autre
                  membre.
                </li>
                <li>
                  <strong>Administrateur</strong> : tous les droits délégables
                  (catalogue, stock, ventes, analyses, corbeille, membres, image
                  du commerce).
                </li>
                <li>
                  <strong>Vendeur</strong> : enregistre des ventes et voit les
                  siennes. Le propriétaire ou un administrateur peut lui ajouter
                  d&apos;autres droits un par un.
                </li>
              </ul>
              <p>
                Le propriétaire du commerce, et les administrateurs pour ce qui
                les concerne :
              </p>
              <ul>
                <li>décident qui rejoint le commerce et avec quels droits ;</li>
                <li>
                  retirent l&apos;accès d&apos;un membre qui ne doit plus
                  l&apos;avoir (statut « Suspendue » ou « Révoquée ») ;
                </li>
                <li>
                  sont responsables des informations saisies dans le commerce :
                  produits, prix, stock, ventes, photos et, le cas échéant, nom
                  ou contact d&apos;un acheteur.
                </li>
              </ul>
              <p>
                Lorsque vous enregistrez des informations sur vos propres
                clients, c&apos;est votre commerce qui en décide l&apos;usage.{" "}
                {SITE.name} les traite pour votre compte, dans les conditions de
                l&apos;
                <Link href="/traitement-donnees">
                  accord de traitement des données
                </Link>
                .
              </p>
            </>
          ),
        },
        {
          id: "usage",
          title: "Utilisation autorisée",
          content: (
            <>
              <p>Vous vous engagez à ne pas :</p>
              <ul>
                <li>utiliser le service pour une activité illégale ;</li>
                <li>
                  tenter d&apos;accéder aux données d&apos;un autre commerce ou
                  à des fonctions pour lesquelles vous n&apos;avez pas reçu de
                  droit ;
                </li>
                <li>
                  perturber le service, le surcharger volontairement, ou
                  l&apos;interroger de façon automatisée sans accord ;
                </li>
                <li>
                  déposer des images dont vous n&apos;avez pas les droits, ou
                  des contenus contraires à la loi ;
                </li>
                <li>
                  enregistrer des informations sur des personnes sans nécessité
                  pour votre activité.
                </li>
              </ul>
            </>
          ),
        },
        {
          id: "securite",
          title: "Sécurité",
          content: (
            <>
              <p>
                {SITE.name} protège l&apos;accès au service : mots de passe
                enregistrés sous forme chiffrée (hachage), liens de confirmation
                et d&apos;invitation à durée limitée, données de chaque commerce
                séparées des autres, droits vérifiés par le serveur à chaque
                action. La{" "}
                <Link href="/confidentialite">
                  politique de confidentialité
                </Link>{" "}
                décrit ces mesures.
              </p>
              <p>De votre côté :</p>
              <ul>
                <li>gardez votre mot de passe secret ;</li>
                <li>
                  signalez sans attendre à <MailLink to="support" /> tout accès
                  que vous n&apos;avez pas autorisé ;
                </li>
                <li>
                  sur un appareil partagé, déconnectez-vous et supprimez les
                  données hors connexion (Organisation, puis Hors connexion).
                </li>
              </ul>
            </>
          ),
        },
        {
          id: "disponibilite",
          title: "Disponibilité et évolution du service",
          content: (
            <>
              <p>
                {SITE.name} fait le nécessaire pour que le service reste
                accessible et que vos données soient conservées. Des
                interruptions peuvent survenir, notamment pour la maintenance ou
                en cas de panne d&apos;un prestataire.
              </p>
              {/* À COMPLÉTER : niveau de service, annonce des interruptions
              prévues, conséquences d'une interruption prolongée. */}
              <p>
                Le service évolue : des fonctions peuvent être ajoutées ou
                modifiées.
              </p>
              {/* À COMPLÉTER : règle de retrait d'une fonction en cours
              d'abonnement. */}
            </>
          ),
        },
        {
          id: "suspension",
          title: "Suspension et fin d'utilisation",
          content: (
            <>
              <p>
                Vous pouvez cesser d&apos;utiliser {SITE.name} à tout moment.
                Les effets sur l&apos;abonnement en cours sont décrits dans les{" "}
                <Link href="/conditions-abonnement">
                  conditions d&apos;abonnement
                </Link>
                .
              </p>
              <p>
                L&apos;accès d&apos;un compte ou d&apos;un commerce peut être
                suspendu en cas de manquement grave à ces conditions,
                d&apos;atteinte à la sécurité du service ou de demande
                d&apos;une autorité.
              </p>
              {/* À COMPLÉTER : procédure de suspension (préavis,
              observations, recours) ; durée de conservation des données d'un
              commerce après la fin, restitution puis suppression. */}
            </>
          ),
        },
        {
          id: "propriete",
          title: "Propriété intellectuelle",
          content: (
            <p>
              Vous pouvez utiliser {SITE.name} pour les besoins de votre
              commerce pendant la durée de votre accès. Les contenus que vous
              ajoutez restent les vôtres : vous autorisez seulement {SITE.name}{" "}
              à les enregistrer et à les afficher aux membres de votre commerce,
              dans le seul but de fournir le service.
            </p>
          ),
        },
        {
          id: "reclamations",
          title: "Réclamations et droits applicables",
          content: (
            <>
              <p>
                Pour une réclamation, écrivez à <MailLink to="support" /> en
                indiquant le commerce concerné et le problème rencontré, ou
                utilisez Organisation, puis Assistance. Toutes les coordonnées
                figurent sur la page <Link href="/contact">Contact</Link>.
              </p>
              <p>
                Ces conditions ne réduisent aucun droit que la loi vous
                reconnaît, en particulier en tant que consommateur ou personne
                dont les données sont traitées. Une clause contraire à ces
                droits serait sans effet.
              </p>
              {/* À COMPLÉTER avec un juriste : droit applicable et règlement
              des litiges (aucun tribunal ni arbitrage imposé). */}
            </>
          ),
        },
        {
          id: "acceptation",
          title: "Acceptation de ces conditions",
          content: (
            <>
              <p>
                Vous acceptez ces conditions en cochant la case prévue à la
                création de votre compte, que vous créiez un commerce ou que
                vous rejoigniez un commerce sur invitation. Cette case
                n&apos;est jamais cochée d&apos;avance, et le compte n&apos;est
                pas créé sans elle.
              </p>
              <p>
                Le serveur de {SITE.name} enregistre alors la preuve de votre
                acceptation : votre compte, le commerce concerné, la date et
                l&apos;heure fixées par le serveur, la langue, la version du
                texte et son empreinte numérique. Cette empreinte permet de
                retrouver le texte exact que vous avez accepté. Chaque version
                acceptée est archivée, et une nouvelle version ne remplace ni
                les textes précédents ni les preuves déjà enregistrées.
              </p>
              <p>
                Si votre compte existait avant la mise en place de cette
                acceptation, ou si une nouvelle version vous concerne, votre
                accord vous sera demandé dans l&apos;application. Aucune
                acceptation n&apos;est enregistrée à votre place.
              </p>
            </>
          ),
        },
        {
          id: "modifications",
          title: "Modification des conditions",
          content: (
            <>
              <p>
                Chaque version est datée. Une modification importante sera
                annoncée avant son entrée en vigueur, et la version applicable
                restera consultable sur cette page.
              </p>
              <p>Langue : ce texte est rédigé en français.</p>
              {/* À DÉCIDER : version anglaise (loi-cadre 2011/012, art. 6). */}
            </>
          ),
        },
      ]}
    />
  );
}
