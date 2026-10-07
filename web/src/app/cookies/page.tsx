import Link from "next/link";
import { DocumentPage } from "@/components/legal/document-page";
import { documentMetadata } from "@/lib/legal/document-metadata";
import { SITE, legalDocument } from "@/lib/legal/site-identity";

// 1-16C — Cookies et stockages navigateur, relevés dans le code web :
// aucun `document.cookie`, aucun en-tête Set-Cookie côté API, aucun script
// tiers ni mesure d'audience. Inventaire : lib/auth.ts, restricted-session,
// commercial-block, payment-intent, pwa-install, engagement-prompt, bases
// IndexedDB `stockmaster-offline-*`, cache du service worker (public/sw.js).
// Les clés techniques héritées (`heyama_*`) sont conservées telles quelles.
const doc = legalDocument("/cookies");

export const metadata = documentMetadata(
  "Cookies et stockage sur l'appareil",
  "Ce que Stock Master enregistre dans le navigateur, à quoi cela sert et comment le supprimer.",
  doc,
);

type Row = { name: string; purpose: string; duration: string };

function StorageTable({ caption, rows }: { caption: string; rows: Row[] }) {
  return (
    <table>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Élément</th>
          <th scope="col">À quoi il sert</th>
          <th scope="col">Durée</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td>
              <code translate="no" className="break-all text-xs">
                {r.name}
              </code>
            </td>
            <td>{r.purpose}</td>
            <td>{r.duration}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function CookiesPage() {
  return (
    <DocumentPage
      title="Cookies et stockage sur l'appareil"
      doc={doc}
      intro={
        <p>
          {SITE.name} n&apos;utilise <strong>aucun cookie</strong>, aucune
          mesure d&apos;audience et aucune publicité. Pour fonctionner,
          l&apos;application enregistre quelques informations dans le navigateur
          de votre appareil. Cette page les liste toutes.
        </p>
      }
      sections={[
        {
          id: "principe",
          title: "Ce qui est enregistré et pourquoi",
          content: (
            <>
              <p>
                Tous les éléments ci-dessous sont nécessaires au service que
                vous demandez : rester connecté, travailler sans connexion,
                retrouver un paiement en cours ou ne pas revoir un message déjà
                fermé. Aucun ne sert à vous suivre sur d&apos;autres sites ni à
                mesurer votre navigation.
              </p>
              <p>
                Ces informations restent sur votre appareil. Seuls le jeton de
                connexion et les ventes en attente sont envoyés au serveur de{" "}
                {SITE.name}, pour vous identifier et enregistrer les ventes.
              </p>
            </>
          ),
        },
        {
          id: "local",
          title: "Stockage du navigateur (localStorage et sessionStorage)",
          content: (
            <StorageTable
              caption="Stockage local et de session"
              rows={[
                {
                  name: "heyama_token",
                  purpose: "Jeton de connexion : vous garde connecté.",
                  duration:
                    "Jusqu'à la déconnexion ; le jeton expire au plus tard après 7 jours",
                },
                {
                  name: "heyama_user",
                  purpose:
                    "Nom, adresse e-mail et identifiant du compte connecté, pour l'affichage.",
                  duration: "Jusqu'à la déconnexion",
                },
                {
                  name: "stockmaster_restricted_session",
                  purpose:
                    "Accès limité quand l'abonnement est expiré, le temps de le renouveler (onglet en cours seulement).",
                  duration: "15 minutes, effacé à la fermeture de l'onglet",
                },
                {
                  name: "stockmaster_commercial_blocks",
                  purpose:
                    "Mémorise qu'un commerce est bloqué par l'abonnement (identifiants seulement), pour que ce blocage reste affiché sans connexion.",
                  duration: "Jusqu'au rétablissement de l'accès",
                },
                {
                  name: "stockmaster_payment_intents",
                  purpose:
                    "Retrouve un paiement d'abonnement en cours après une coupure (inutilisé tant que le paiement en ligne est fermé).",
                  duration: "Jusqu'à la fin du paiement",
                },
                {
                  name: "stockmaster.pwa.installed",
                  purpose:
                    "Retient que l'application a été installée sur l'appareil.",
                  duration: "Sans limite, effaçable par vous",
                },
                {
                  name: "stockmaster.engagement.lastModalAt",
                  purpose:
                    "Date du dernier message proposant notifications ou installation, pour ne pas le répéter.",
                  duration: "Sans limite, effaçable par vous",
                },
                {
                  name: "stockmaster.engagement.bannerHidden",
                  purpose:
                    "Retient la fermeture de ce message pendant la visite.",
                  duration: "Jusqu'à la fermeture de l'onglet",
                },
              ]}
            />
          ),
        },
        {
          id: "hors-ligne",
          title: "Données hors connexion (IndexedDB)",
          content: (
            <>
              <StorageTable
                caption="Bases IndexedDB"
                rows={[
                  {
                    name: "stockmaster-offline-catalog",
                    purpose:
                      "Copie du catalogue (noms, prix de vente, stock restant ; jamais le prix d'achat), pour consulter et vendre sans réseau.",
                    duration: "Utilisable 72 heures ; effacée à la déconnexion",
                  },
                  {
                    name: "stockmaster-offline-identity",
                    purpose:
                      "Identifiants du compte et du commerce en cours, pour rouvrir l'application sans réseau.",
                    duration: "Effacée à la déconnexion",
                  },
                  {
                    name: "stockmaster-offline-sales-capability",
                    purpose:
                      "Indique seulement si vous avez le droit d'enregistrer des ventes.",
                    duration: "72 heures ; effacée à la déconnexion",
                  },
                  {
                    name: "stockmaster-offline-tenant-brand",
                    purpose:
                      "Nom et couleur du commerce, pour l'affichage sans réseau.",
                    duration: "Effacée à la déconnexion",
                  },
                  {
                    name: "stockmaster-offline-sales-outbox",
                    purpose:
                      "Ventes enregistrées sans connexion, en attente d'envoi. Peut contenir le nom et le contact d'un acheteur s'ils ont été saisis.",
                    duration:
                      "Jusqu'à l'envoi ; au plus 14 jours en attente ; gardées 7 jours après l'envoi",
                  },
                ]}
              />
              <p>
                Les ventes en attente ne sont <strong>pas</strong> effacées à la
                déconnexion, pour ne pas perdre une vente. Elles peuvent être
                exportées depuis la page des ventes en attente.
              </p>
            </>
          ),
        },
        {
          id: "cache",
          title: "Cache de l'application (service worker)",
          content: (
            <p>
              Pour s&apos;ouvrir sans réseau, l&apos;application garde une copie
              de ses fichiers publics : pages d&apos;accueil, de connexion et
              d&apos;inscription, page hors connexion, page du catalogue,
              icônes, logo et code de l&apos;application. Ce cache ne contient
              ni vos données de compte ni celles du commerce, et
              n&apos;enregistre jamais les liens de confirmation,
              d&apos;invitation ou de réinitialisation.
            </p>
          ),
        },
        {
          id: "tiers",
          title: "Contenus chargés depuis d'autres services",
          content: (
            <ul>
              <li>
                Les photos de produits et les logos sont chargés depuis le
                service de stockage du site (Supabase). Comme pour toute image
                en ligne, ce service reçoit l&apos;adresse IP de
                l&apos;appareil.
              </li>
              <li>
                Si vous activez les notifications, le navigateur s&apos;inscrit
                auprès de son propre service de notification.
              </li>
              <li>
                Aucun script de réseau social, de publicité ou de mesure
                d&apos;audience n&apos;est chargé.
              </li>
            </ul>
          ),
        },
        {
          id: "consentement",
          title: "Faut-il votre accord ?",
          content: (
            <>
              <p>
                Comme tous ces éléments sont nécessaires au service demandé et
                qu&apos;aucun n&apos;est utilisé pour de la publicité ou de la
                mesure d&apos;audience, aucune fenêtre de consentement
                n&apos;est affichée. Il n&apos;existe aujourd&apos;hui aucun
                usage facultatif.
              </p>
              <p>
                Les notifications sur l&apos;appareil ne sont jamais activées
                sans votre action : vous les activez dans l&apos;application,
                puis le navigateur vous demande sa propre autorisation.
              </p>
              {/* À VALIDER par un juriste : besoin de consentement au regard
              de la loi n° 2024/017 et de la loi sur la cybersécurité. */}
            </>
          ),
        },
        {
          id: "supprimer",
          title: "Comment tout supprimer",
          content: (
            <ul>
              <li>
                <strong>Se déconnecter</strong> efface le jeton de connexion et
                les données hors connexion, sauf les ventes pas encore envoyées.
              </li>
              <li>
                Dans l&apos;application,{" "}
                <strong>
                  Organisation, puis Hors connexion, puis « Supprimer les
                  données hors connexion »
                </strong>{" "}
                efface les mêmes données sans vous déconnecter.
              </li>
              <li>
                Dans les réglages du navigateur, effacer les données du site{" "}
                <span translate="no">{SITE.domain}</span> supprime tout, y
                compris les ventes en attente : exportez-les ou attendez leur
                envoi avant.
              </li>
              <li>
                Pour arrêter les notifications d&apos;un appareil, voir le{" "}
                <Link href="/guide#notifications">guide</Link>.
              </li>
            </ul>
          ),
        },
      ]}
    />
  );
}
