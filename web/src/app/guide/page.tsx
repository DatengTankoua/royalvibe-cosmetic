import Link from "next/link";
import { DocumentPage } from "@/components/legal/document-page";
import { MailLink } from "@/components/legal/mail-link";
import { documentMetadata } from "@/lib/legal/document-metadata";
import { SITE } from "@/lib/legal/site-identity";
import { TRIAL_DAYS } from "@/lib/subscription-offers";

// 1-16C — Guide d'utilisation. Chaque étape reprend les libellés réels de
// l'interface et les limites mesurées dans le code (durées, droits,
// hors ligne). Notifications push : aucun appareil Android ni iPhone réel
// n'a encore été testé ; rien n'est présenté comme validé.
export const metadata = documentMetadata(
  "Guide d'utilisation",
  "Inscription, commerce et membres, produits, stock, ventes, analyses, corbeille, hors connexion, abonnement et notifications : le guide pas à pas de Stock Master.",
);

export default function GuidePage() {
  const registrationEnabled =
    process.env.NEXT_PUBLIC_REGISTRATION_ENABLED === "true";

  return (
    <DocumentPage
      title="Guide d'utilisation"
      intro={
        <p>
          Ce guide explique, étape par étape, comment utiliser {SITE.name} dans
          votre commerce. Les noms des boutons sont écrits comme dans
          l&apos;application.
        </p>
      }
      sections={[
        {
          id: "inscription",
          title: "S'inscrire et confirmer son adresse e-mail",
          content: (
            <>
              {!registrationEnabled && (
                <p>
                  <strong>
                    Les inscriptions en ligne sont momentanément fermées.
                  </strong>{" "}
                  Les étapes ci-dessous s&apos;appliqueront à leur réouverture.
                  Un vendeur invité peut toujours rejoindre un commerce (voir la
                  section suivante).
                </p>
              )}
              <ol>
                <li>
                  Ouvrez la page{" "}
                  {registrationEnabled ? (
                    <Link href="/auth/register">Inscription</Link>
                  ) : (
                    "Inscription"
                  )}{" "}
                  et indiquez votre nom, votre adresse e-mail, un mot de passe
                  de 6 à 100 caractères et le nom de votre commerce (20
                  caractères au plus).
                </li>
                <li>
                  Lisez puis acceptez les{" "}
                  <Link href="/conditions-utilisation">
                    conditions d&apos;utilisation
                  </Link>{" "}
                  et les{" "}
                  <Link href="/conditions-abonnement">
                    conditions d&apos;abonnement
                  </Link>{" "}
                  en cochant la case prévue : le compte n&apos;est pas créé sans
                  elle.
                </li>
                <li>
                  Un e-mail de confirmation vous est envoyé. Ouvrez le lien
                  qu&apos;il contient dans les 24 heures.
                </li>
                <li>
                  Vous pouvez ensuite vous{" "}
                  <Link href="/auth/login">connecter</Link>. L&apos;essai
                  gratuit de {TRIAL_DAYS} jours a commencé à la création du
                  commerce.
                </li>
              </ol>
              <p>
                Pas d&apos;e-mail ? Vérifiez le dossier des indésirables, puis
                essayez de vous connecter : l&apos;écran de connexion propose
                alors de renvoyer le lien. Si vous oubliez votre mot de passe,
                utilisez « Mot de passe oublié ? » : le lien reçu est valable 1
                heure.
              </p>
            </>
          ),
        },
        {
          id: "membres",
          title:
            "Créer son commerce, inviter des membres, choisir leurs droits",
          content: (
            <>
              <p>
                Votre commerce est créé à l&apos;inscription, et vous en êtes le
                propriétaire. Dans <strong>Organisation</strong>, vous pouvez
                modifier son nom, son logo et sa couleur (Branding), et gérer
                l&apos;équipe.
              </p>
              <h3>Inviter un membre</h3>
              <ol>
                <li>
                  Ouvrez <strong>Organisation, puis Invitations</strong>, et
                  créez une invitation avec l&apos;adresse e-mail de la
                  personne, son rôle et ses droits.
                </li>
                <li>
                  Copiez le lien affiché et envoyez-le vous-même, par SMS ou
                  messagerie. {SITE.name} n&apos;envoie pas l&apos;invitation
                  par e-mail. Le lien n&apos;est affiché qu&apos;une fois et
                  reste valable 72 heures.
                </li>
                <li>
                  La personne ouvre le lien et crée son accès. Si elle n&apos;a
                  pas encore de compte, elle accepte les conditions
                  d&apos;utilisation en cochant la case prévue.
                </li>
              </ol>
              <h3>Rôles et droits</h3>
              <ul>
                <li>
                  <strong>Propriétaire</strong> : tous les droits, abonnement et
                  transfert de la propriété.
                </li>
                <li>
                  <strong>Administrateur</strong> : tous les droits sauf ceux
                  propres au propriétaire.
                </li>
                <li>
                  <strong>Vendeur</strong> : enregistre des ventes et voit les
                  siennes. Vous pouvez lui ajouter d&apos;autres droits un par
                  un (voir toutes les ventes, gérer le catalogue, ajuster le
                  stock, voir les analyses, contacter le service client…).
                </li>
              </ul>
              <p>
                Dans <strong>Organisation, puis Membres</strong>, choisissez «
                Modifier » sur un membre pour changer ses droits ou son statut :
                « Suspendue » retire l&apos;accès temporairement, « Révoquée »
                le retire définitivement. Le propriétaire peut aussi «
                Transférer la propriété » à un autre membre.
              </p>
            </>
          ),
        },
        {
          id: "catalogue",
          title: "Produits, catégories, stock, ventes et analyses",
          content: (
            <>
              <h3>Ranger les produits par catégorie</h3>
              <p>
                Dans <strong>Catalogue</strong>, créez vos catégories avec «
                Nouvelle section » (par exemple Boissons, Épicerie). Une
                catégorie peut contenir des sous-catégories.
              </p>
              <h3>Ajouter un produit</h3>
              <p>
                Ouvrez une catégorie, puis ajoutez un produit : nom, photo, prix
                d&apos;achat, prix de vente et quantité initiale (en FCFA). La
                photo est obligatoire.
              </p>
              <h3>Suivre et compléter le stock</h3>
              <ul>
                <li>
                  Chaque vente fait baisser le stock du produit. La fiche
                  produit indique « En stock », « Stock faible » ou « Épuisé ».
                </li>
                <li>
                  Pour ajouter des marchandises, choisissez « Modifier » sur le
                  produit et indiquez la quantité ajoutée (droit « Ajuster le
                  stock »).
                </li>
              </ul>
              <h3>Enregistrer une vente</h3>
              <ol>
                <li>Ouvrez le produit dans le catalogue.</li>
                <li>Choisissez « Enregistrer une vente ».</li>
                <li>
                  Indiquez la quantité et le prix de vente réel. Le nom et le
                  contact de l&apos;acheteur sont facultatifs : ne les saisissez
                  que si votre commerce en a besoin.
                </li>
                <li>
                  Validez. La vente apparaît dans <strong>Ventes</strong>.
                </li>
              </ol>
              <p>
                Une vente peut être corrigée ou supprimée par la suite, selon
                vos droits. Supprimer une vente remet la quantité en stock.
              </p>
              <h3>Comprendre l&apos;activité</h3>
              <p>
                <strong>Analyse</strong> (droit « Voir les analyses ») présente
                le capital investi, le chiffre d&apos;affaires, le bénéfice, la
                marge, les unités vendues, l&apos;évolution mensuelle et les
                classements des produits et des vendeurs. Un bilan du mois
                écoulé est aussi produit au début de chaque mois.
              </p>
              <p>
                Quand un mois est choisi, la carte devient « Gain estimé du mois
                » : montant des ventes du mois moins le prix d&apos;achat actuel
                des produits vendus ce mois-là (prix conservé lors de la
                suppression d&apos;un produit). Si ce prix est inconnu pour une
                vente du mois, le gain est affiché « — » plutôt que faux.
              </p>
              <h3>Télécharger l&apos;historique d&apos;un mois</h3>
              <ul>
                <li>
                  Le propriétaire et l&apos;administrateur trouvent, en haut de{" "}
                  <strong>Analyse</strong>, le bloc « Historique mensuel » :
                  choisissez un mois, puis « Télécharger en Excel » ou «
                  Télécharger en PDF ».
                </li>
                <li>
                  Le fichier contient un bilan du mois, toutes les ventes (date,
                  produit, quantité, prix, montant, vendeur, acheteur), un
                  récapitulatif par produit et par vendeur, et les corrections
                  et annulations de ventes du mois.
                </li>
                <li>
                  Les chiffres suivent les mêmes règles que l&apos;écran
                  Analyse. Le nom d&apos;un produit est celui enregistré lors de
                  la vente, même s&apos;il a été renommé ou supprimé depuis. Une
                  valeur inconnue est notée « Information indisponible », jamais
                  zéro.
                </li>
                <li>
                  Les ventes encore en attente de synchronisation sur un
                  appareil n&apos;y figurent pas : synchronisez-les avant de
                  télécharger.
                </li>
                <li>
                  Le PDF reproduit les noms à l&apos;identique (accents, œ,
                  apostrophes comprises). Si un nom contient des caractères
                  qu&apos;il ne peut pas reproduire (autre alphabet, émoji…), il
                  est refusé avec un message : téléchargez alors l&apos;Excel,
                  qui conserve les noms exactement.
                </li>
                <li>
                  Le téléchargement nécessite une connexion Internet. Le fichier
                  contient des informations sur les acheteurs : conservez-le en
                  lieu sûr.
                </li>
              </ul>
            </>
          ),
        },
        {
          id: "corbeille",
          title: "Corbeille, suppression définitive et historique des ventes",
          content: (
            <>
              <ul>
                <li>
                  Supprimer un produit ou une catégorie le place dans la{" "}
                  <strong>Corbeille</strong> (« Placer dans la corbeille »).
                  Rien n&apos;est encore effacé : vous pouvez le « Restaurer ».
                </li>
                <li>
                  Dans la corbeille, « Supprimer définitivement » efface le
                  produit et sa photo. Cette action ne peut pas être annulée.
                </li>
                <li>
                  L&apos;historique des ventes est conservé après une
                  suppression définitive : les ventes passées gardent le nom du
                  produit et restent comptées dans les analyses.
                </li>
              </ul>
              <p>La corbeille demande le droit « Gérer la corbeille ».</p>
            </>
          ),
        },
        {
          id: "hors-ligne",
          title: "Travailler sans connexion",
          content: (
            <>
              <p>
                {SITE.name} permet de continuer à vendre quand le réseau coupe,
                avec ces conditions :
              </p>
              <ul>
                <li>
                  vous devez avoir ouvert l&apos;application avec du réseau dans
                  les <strong>72 dernières heures</strong>, sur le même appareil
                  et avec le même compte ;
                </li>
                <li>
                  sans réseau, seuls le catalogue et l&apos;enregistrement des
                  ventes sont disponibles. Ajouter des produits, consulter les
                  analyses ou gérer l&apos;équipe demande une connexion ;
                </li>
                <li>
                  le stock affiché sans réseau est indicatif : il ne tient pas
                  compte des ventes faites entre-temps sur d&apos;autres
                  appareils.
                </li>
              </ul>
              <h3>Synchronisation</h3>
              <ul>
                <li>
                  Les ventes saisies sans réseau sont marquées « en attente » et
                  envoyées automatiquement au retour de la connexion.
                </li>
                <li>
                  Le serveur vérifie chaque vente. Si l&apos;une est refusée
                  (stock insuffisant, droit retiré…), elle reste dans « Ventes
                  en attente » pour que vous la corrigiez.
                </li>
                <li>
                  Un appareil garde au plus 200 ventes en attente, chacune
                  pendant 14 jours au plus. Si l&apos;envoi tarde, ouvrez «
                  Ventes en attente » pour voir la raison et les corriger ou les
                  relancer.
                </li>
                <li>La déconnexion ne supprime pas les ventes en attente.</li>
              </ul>
            </>
          ),
        },
        {
          id: "abonnement",
          title: "Abonnement et renouvellement",
          content: (
            <>
              <ul>
                <li>
                  L&apos;essai de {TRIAL_DAYS} jours démarre à la création du
                  commerce. Son état et sa date de fin sont visibles dans{" "}
                  <strong>Organisation, puis Abonnement</strong>.
                </li>
                <li>
                  Les durées et les prix figurent dans les{" "}
                  <Link href="/conditions-abonnement">
                    conditions d&apos;abonnement
                  </Link>
                  .
                </li>
                <li>
                  Le paiement en ligne n&apos;est pas encore disponible. Pour
                  renouveler, le propriétaire écrit depuis Organisation, puis
                  Assistance (catégorie « Abonnement »), ou à{" "}
                  <MailLink
                    to="support"
                    subject="Renouvellement de l'abonnement"
                  />
                  .
                </li>
                <li>
                  À l&apos;échéance sans renouvellement, l&apos;accès au
                  commerce est bloqué pour tous ses membres. Les données ne sont
                  pas effacées, et les ventes en attente restent sur
                  l&apos;appareil.
                </li>
              </ul>
            </>
          ),
        },
        {
          id: "notifications",
          title: "Notifications, installation et push",
          content: (
            <>
              <h3>Centre de notifications</h3>
              <p>
                La cloche en haut de l&apos;application ouvre vos notifications
                : stock épuisé ou presque épuisé, nouvelles ventes, fin
                d&apos;essai ou d&apos;abonnement, paiement confirmé, bilan
                mensuel. Vous ne recevez que celles qui correspondent à vos
                droits.
              </p>
              <h3>Installer l&apos;application</h3>
              <ul>
                <li>
                  Sur les navigateurs qui le permettent (par exemple Chrome), le
                  bouton « Installer » ajoute {SITE.name} à l&apos;écran
                  d&apos;accueil.
                </li>
                <li>
                  Sur iPhone et iPad, dans Safari : touchez Partager, puis « Sur
                  l&apos;écran d&apos;accueil ».
                </li>
              </ul>
              <h3>
                Activer ou désactiver les notifications sur l&apos;appareil
              </h3>
              <ol>
                <li>
                  Ouvrez <strong>Organisation, puis Notifications</strong>.
                </li>
                <li>
                  Choisissez « Activer les notifications », puis acceptez la
                  demande du navigateur.
                </li>
                <li>Cochez les catégories qui vous intéressent.</li>
                <li>
                  Pour arrêter, choisissez « Désactiver les notifications ».
                  Vous pouvez aussi les bloquer dans les réglages du navigateur.
                </li>
              </ol>
              <p>
                Le réglage vaut pour cet appareil seulement. Sur iPhone et iPad,
                les notifications ne sont proposées qu&apos;à l&apos;application
                ajoutée à l&apos;écran d&apos;accueil.
              </p>
              <p>
                <strong>Important :</strong> les notifications sur appareil
                n&apos;ont pas encore été testées sur de vrais téléphones
                Android ou iPhone. Elles peuvent ne pas arriver sur certains
                appareils : le centre de notifications de l&apos;application
                reste la référence.
              </p>
            </>
          ),
        },
        {
          id: "aide",
          title: "Besoin d'aide ?",
          content: (
            <>
              <h3>Depuis l&apos;application</h3>
              <ol>
                <li>
                  Ouvrez <strong>Organisation, puis Assistance</strong>.
                </li>
                <li>
                  Choisissez une catégorie (Utilisation, Abonnement, Problème
                  technique, Autre), puis écrivez un sujet et votre message.
                </li>
                <li>
                  Vérifiez le bloc « Informations transmises au service client »
                  : votre nom, votre e-mail, votre commerce, votre rôle et des
                  identifiants sont joints automatiquement pour retrouver votre
                  compte. Aucune vente ni aucun contact d&apos;acheteur
                  n&apos;est joint.
                </li>
                <li>
                  Choisissez « Envoyer au service client ». Une référence de
                  demande s&apos;affiche : notez-la. La réponse arrive à votre
                  adresse e-mail.
                </li>
              </ol>
              <p>
                L&apos;envoi demande une connexion Internet. En cas
                d&apos;échec, votre texte reste sur l&apos;écran : réessayez
                sans le retaper. Le propriétaire et les administrateurs ont
                accès à l&apos;Assistance ; un vendeur seulement si le droit «
                Contacter le service client » lui a été donné.
              </p>
              <h3>Par e-mail</h3>
              <p>
                Si vous ne pouvez pas accéder à votre commerce, écrivez à{" "}
                <MailLink to="support" /> en précisant le nom de votre commerce,
                l&apos;écran concerné et ce que vous avez essayé. Les autres
                contacts sont sur la page <Link href="/contact">Contact</Link>.
              </p>
            </>
          ),
        },
      ]}
    />
  );
}
