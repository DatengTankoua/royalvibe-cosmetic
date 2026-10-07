import { MailLink } from "@/components/legal/mail-link";
import {
  LOCATIONS,
  OPERATOR,
  PROVIDERS,
  SITE,
} from "@/lib/legal/site-identity";

// 1-16C / 1-16C.1 — Mentions légales (loi 2010/021, art. 30 ; décret
// 2011/1521/PM, art. 5). Coordonnées confirmées par le propriétaire le
// 7 octobre 2026 (site-identity.ts). Éléments encore attendus : en
// commentaire, jamais affichés vides ni inventés.
import type { DocumentContent } from "@/i18n/documents/types";

// 1-16G : texte français déplacé tel quel depuis la page (le texte
// affiché, archivé et accepté ne change pas).
const content: DocumentContent = {
  metaTitle: "Mentions légales",
  metaDescription:
    "Exploitant, implantations, contacts, hébergement et propriété intellectuelle du service Stock Master.",
  title: "Mentions légales",
  intro: (
    <p>
      Cette page indique qui exploite le service {SITE.name}, accessible à
      l&apos;adresse <span translate="no">{SITE.url}</span>, et comment le
      joindre.
    </p>
  ),
  sections: [
    {
      id: "exploitant",
      title: "Exploitant du service",
      content: (
        <>
          <ul>
            <li>
              Nom : <strong>{OPERATOR.legalName}</strong>
            </li>
            <li>Nom commercial : {OPERATOR.tradeName}</li>
            <li>
              Exploitant : {OPERATOR.kind} établie au {SITE.country}
            </li>
            {/* À AJOUTER quand communiqués : téléphone, RCCM, NIU,
                forme juridique, capital (site-identity.ts → OPERATOR). */}
          </ul>
          <h3>Implantations</h3>
          <ul>
            {LOCATIONS.map((location) => (
              <li key={location}>{location}</li>
            ))}
          </ul>
        </>
      ),
    },
    {
      id: "contacts",
      title: "Nous contacter",
      content: (
        <>
          <ul>
            <li>
              Questions générales : <MailLink to="contact" />
            </li>
            <li>
              Assistance et réclamations : <MailLink to="support" />
            </li>
            <li>
              Données personnelles : <MailLink to="privacy" />
            </li>
          </ul>
          <p>
            Les e-mails automatiques (lien de confirmation, réinitialisation du
            mot de passe) sont envoyés depuis une adresse du domaine{" "}
            <span translate="no">{SITE.domain}</span> et ne doivent pas recevoir
            de réponse.
          </p>
          {/* Expéditeur réel : configuration EMAIL_FROM existante (adresse
              du domaine vérifié chez Resend), non lue dans ce lot. */}
          {/* À AJOUTER : numéro de téléphone (annoncé ultérieurement). */}
        </>
      ),
    },
    // À AJOUTER : section « Directeur de la publication » dès que le nom
    // est communiqué (décret 2011/1521/PM, art. 5).
    {
      id: "hebergement",
      title: "Hébergement",
      content: (
        <>
          <p>
            Le nom de domaine <span translate="no">{SITE.domain}</span> est
            enregistré auprès de Namecheap. L&apos;application s&apos;appuie sur
            les prestataires techniques suivants :
          </p>
          <ul>
            {PROVIDERS.map((p) => (
              <li key={p.name}>
                <span translate="no">{p.name}</span> : {p.role.toLowerCase()}
              </li>
            ))}
          </ul>
          {/* À AJOUTER : raison sociale, adresse et pays d'hébergement de
              chaque prestataire, après vérification dans leurs tableaux de
              bord (PROVIDERS.country reste null tant que non confirmé). */}
        </>
      ),
    },
    {
      id: "propriete",
      title: "Propriété intellectuelle",
      content: (
        <>
          <p>
            Le nom {SITE.name}, le logo, les textes, les écrans et le code du
            service ne peuvent pas être reproduits ou réutilisés sans
            autorisation écrite de l&apos;exploitant.
          </p>
          {/* À AJOUTER : titulaire des droits et dépôt de marque éventuel. */}
          <p>
            Les contenus ajoutés par les commerces (noms de produits, photos,
            logos) restent la propriété de ceux qui les publient. Les conditions
            d&apos;utilisation précisent ce que chacun peut en faire.
          </p>
        </>
      ),
    },
  ],
};

export default content;
