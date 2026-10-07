import Link from "next/link";
import { MailLink } from "@/components/legal/mail-link";
import { SITE } from "@/lib/legal/site-identity";
import {
  SUBSCRIPTION_OFFERS,
  TRIAL_DAYS,
  formatFcfa,
  monthlyEquivalentXaf,
} from "@/lib/subscription-offers";

// 1-16C — Conditions d'abonnement. Tarifs et essai lus dans
// `lib/subscription-offers.ts` (miroir vérifié de
// `api/src/subscriptions/subscription-pricing.ts` et `TRIAL_DURATION_MS`),
// jamais recopiés. Paiement en ligne : `UnavailablePaymentProvider` en
// production (CamPay désactivé) ; aucun renouvellement payant n'est décrit
// tant que sa procédure n'est pas confirmée.
import type { DocumentContent } from "@/i18n/documents/types";
import subscriptionFr from "@/i18n/resources/fr/subscription";

const TERM_LABELS = subscriptionFr.offers.term;

// 1-16G : texte français déplacé tel quel depuis la page (le texte
// affiché, archivé et accepté ne change pas).
const content: DocumentContent = {
  metaTitle: "Conditions d'abonnement",
  metaDescription:
    "Essai gratuit, durées et prix en FCFA, activation, expiration, renouvellement et réclamations pour l'abonnement Stock Master.",
  title: "Conditions d'abonnement",
  intro: (
    <p>
      Ces conditions décrivent l&apos;essai gratuit et l&apos;abonnement payant
      à {SITE.name} : ce qu&apos;ils comprennent, leur durée, leur prix et ce
      qui se passe à leur échéance. Elles complètent les{" "}
      <Link href="/conditions-utilisation">conditions d&apos;utilisation</Link>.
    </p>
  ),
  sections: [
    {
      id: "offre",
      title: "Ce que comprend l'abonnement",
      content: (
        <>
          <p>
            Il existe une seule offre, avec toutes les fonctions de {SITE.name}.
            L&apos;abonnement est pris pour un commerce, et non pour une
            personne :
          </p>
          <ul>
            <li>
              tous les membres du commerce sont inclus, sans supplément par
              vendeur ;
            </li>
            <li>
              chaque membre accède aux fonctions selon les droits que le
              commerce lui a donnés ;
            </li>
            <li>
              l&apos;abonnement est géré par le propriétaire du commerce, dans
              Organisation, puis Abonnement.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "essai",
      title: "Essai gratuit",
      content: (
        <ul>
          <li>
            Un essai gratuit de {TRIAL_DAYS} jours démarre automatiquement à la
            création du commerce.
          </li>
          <li>Aucun moyen de paiement n&apos;est demandé pour l&apos;essai.</li>
          <li>Un commerce ne bénéficie que d&apos;un seul essai.</li>
          <li>
            Si les notifications « Fin d&apos;essai ou d&apos;abonnement » sont
            activées, un rappel est envoyé dans les 24 heures qui précèdent la
            fin.
          </li>
          <li>
            À la fin de l&apos;essai, l&apos;accès au commerce est limité comme
            décrit à la section « Expiration ».
          </li>
        </ul>
      ),
    },
    {
      id: "prix",
      title: "Durées et prix",
      content: (
        <>
          <p>
            Le montant indiqué est le total à payer pour la durée choisie, en
            francs CFA (XAF).
          </p>
          <table>
            <caption className="sr-only">
              Durées et prix de l&apos;abonnement
            </caption>
            <thead>
              <tr>
                <th scope="col">Durée</th>
                <th scope="col">Total</th>
                <th scope="col">Équivalent mensuel</th>
              </tr>
            </thead>
            <tbody>
              {SUBSCRIPTION_OFFERS.map((offer) => (
                <tr key={offer.term}>
                  <td>{TERM_LABELS[offer.term]}</td>
                  <td className="whitespace-nowrap tabular-nums">
                    {formatFcfa(offer.totalXaf, "fr")}
                  </td>
                  <td className="tabular-nums">
                    {offer.months > 1
                      ? `${formatFcfa(monthlyEquivalentXaf(offer), "fr")} (${formatFcfa(offer.savingXaf, "fr")} d'économie)`
                      : "Paiement mois par mois"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* À COMPLÉTER : régime fiscal et mention « toutes taxes
              comprises » ou montant des taxes (loi 2010/021, art. 31). */}
          <p>
            Le prix applicable est celui affiché au moment où la période est
            accordée. Une période déjà accordée n&apos;est jamais modifiée par
            un changement de prix.
          </p>
        </>
      ),
    },
    {
      id: "duree",
      title: "Début et durée d'une période",
      content: (
        <ul>
          <li>
            Une période se compte en mois du calendrier : une période d&apos;un
            mois commencée le 10 mars se termine le 10 avril à la même heure. Si
            le jour n&apos;existe pas (31), elle se termine le dernier jour du
            mois.
          </li>
          <li>
            Une période accordée avant la fin de l&apos;essai ou de la période
            en cours commence à la fin de celle-ci : le temps déjà accordé
            n&apos;est jamais perdu.
          </li>
          <li>
            L&apos;état de l&apos;abonnement et ses dates sont visibles dans
            Organisation, puis Abonnement.
          </li>
        </ul>
      ),
    },
    {
      id: "renouvellement",
      title: "Paiement et renouvellement",
      content: (
        <>
          {/* 1-16C.2 (0.4) : remplace l'annonce d'un paiement en ligne
              disponible (version 0.3), contraire au code
              (`UnavailablePaymentProvider`). Aucune procédure de paiement ni
              garantie de renouvellement n'est décrite. */}
          <p>
            Le paiement en ligne n&apos;est pas encore activé. Pour toute
            demande de renouvellement, contactez{" "}
            <MailLink to="support" subject="Renouvellement de l'abonnement" />.
          </p>
          <ul>
            <li>
              Il n&apos;y a aucun renouvellement ni prélèvement automatique :
              chaque nouvelle période est une décision du propriétaire.
            </li>
            {/* À COMPLÉTER : moyens de paiement acceptés, justificatif
                remis et délai d'activation, une fois la procédure confirmée. */}
          </ul>
        </>
      ),
    },
    {
      id: "expiration",
      title: "Expiration",
      content: (
        <>
          <p>
            À la fin de l&apos;essai ou de la dernière période payée, sans
            nouvelle période :
          </p>
          <ul>
            <li>
              l&apos;accès aux pages du commerce est bloqué pour tous ses
              membres, y compris sur les appareils déjà connectés ;
            </li>
            <li>
              le propriétaire voit un écran qui l&apos;invite à renouveler ; les
              autres membres sont invités à le contacter ;
            </li>
            <li>
              les ventes enregistrées sans connexion et pas encore envoyées
              restent sur l&apos;appareil ; elles sont envoyées lorsque
              l&apos;accès est rétabli, dans la limite de 14 jours après leur
              saisie ;
            </li>
            <li>
              les données du commerce ne sont pas supprimées automatiquement à
              l&apos;expiration.
            </li>
          </ul>
          {/* À COMPLÉTER : durée de conservation des données d'un
              commerce qui ne renouvelle pas, et possibilité de les récupérer. */}
        </>
      ),
    },
    {
      id: "resiliation",
      title: "Arrêt, rétractation et remboursement",
      content: (
        <>
          <p>
            Comme rien n&apos;est renouvelé automatiquement, il suffit de ne pas
            renouveler pour arrêter l&apos;abonnement à la fin de la période en
            cours.
          </p>
          {/* À COMPLÉTER avant tout paiement : arrêt anticipé et
              remboursement ; droit de rétractation (loi 2010/021, art. 20 ;
              décret 2011/1521/PM, art. 13 à 15 et 20 ; loi-cadre 2011/012,
              art. 7), à fixer avec un juriste. */}
        </>
      ),
    },
    {
      id: "acceptation",
      title: "Qui accepte ces conditions",
      content: (
        <>
          <p>
            Ces conditions engagent la personne qui crée le commerce et en
            devient propriétaire. Elle les accepte en cochant la case prévue à
            l&apos;inscription, avec les conditions d&apos;utilisation. Cette
            case n&apos;est jamais cochée d&apos;avance.
          </p>
          <p>
            Les administrateurs et les vendeurs invités acceptent les conditions
            d&apos;utilisation, pas ces conditions. Après un transfert de
            propriété, l&apos;accord du nouveau propriétaire lui sera demandé
            dans l&apos;application.
          </p>
          <p>
            La preuve de l&apos;acceptation est enregistrée par le serveur comme
            décrit dans les{" "}
            <Link href="/conditions-utilisation#acceptation">
              conditions d&apos;utilisation
            </Link>
            , avec le commerce concerné.
          </p>
        </>
      ),
    },
    {
      id: "reclamations",
      title: "Réclamations",
      content: (
        <>
          <p>
            Pour toute question ou réclamation sur l&apos;essai, une période ou
            un paiement, écrivez à <MailLink to="support" /> en indiquant le nom
            du commerce et l&apos;adresse e-mail du propriétaire.
          </p>
          {/* À COMPLÉTER : délai de réponse aux réclamations. */}
          <p>
            Ces conditions ne réduisent aucun droit que la loi vous reconnaît.
          </p>
        </>
      ),
    },
  ],
};

export default content;
