import Link from "next/link";
import { DocumentPage } from "@/components/legal/document-page";
import { MailLink } from "@/components/legal/mail-link";
import { documentMetadata } from "@/lib/legal/document-metadata";
import { LOCATIONS, SITE } from "@/lib/legal/site-identity";

// 1-16C / 1-16C.1 — Contact public par liens e-mail (aucun formulaire
// public). Reste la voie pour toute personne qui ne peut pas accéder à son
// organisation ; le formulaire Organisation → Assistance est réservé aux
// membres autorisés.
export const metadata = documentMetadata(
  "Contact",
  "Assistance, réclamations et demandes concernant les données personnelles pour Stock Master.",
);

export default function ContactPage() {
  return (
    <DocumentPage
      title="Contacter Stock Master"
      intro={
        <p>
          Choisissez l&apos;adresse qui correspond à votre demande : elle arrive
          directement à la bonne personne.
        </p>
      }
      sections={[
        {
          id: "assistance",
          title: "Assistance",
          content: (
            <>
              <p>
                <strong>Depuis l&apos;application :</strong> si votre rôle le
                permet, ouvrez <strong>Organisation, puis Assistance</strong>.
                Votre message part avec les informations utiles sur votre compte
                et votre commerce, et la réponse arrive à votre adresse e-mail.
              </p>
              <p>
                <strong>Par e-mail :</strong>{" "}
                <MailLink to="support" subject="Demande d'assistance" />, par
                exemple si vous ne pouvez plus vous connecter ou accéder à votre
                commerce. Indiquez :
              </p>
              <ul>
                <li>
                  le nom de votre commerce et l&apos;adresse e-mail de votre
                  compte ;
                </li>
                <li>l&apos;écran concerné et ce que vous avez essayé ;</li>
                <li>le type d&apos;appareil et de navigateur.</li>
              </ul>
              <p>
                N&apos;envoyez jamais votre mot de passe : {SITE.name} ne vous
                le demandera pas.
              </p>
              <p>
                Le <Link href="/guide">guide d&apos;utilisation</Link> répond
                aux questions les plus fréquentes.
              </p>
            </>
          ),
        },
        {
          id: "reclamations",
          title: "Réclamations",
          content: (
            <p>
              Pour contester une période d&apos;abonnement, un paiement ou le
              fonctionnement du service :{" "}
              <MailLink to="support" subject="Réclamation" />. Décrivez les
              faits, les dates et ce que vous demandez.
              {/* À AJOUTER : délai de traitement des réclamations, quand il
              sera décidé. */}
            </p>
          ),
        },
        {
          id: "donnees",
          title: "Données personnelles",
          content: (
            <>
              <p>
                Pour accéder à vos données, les corriger, les faire supprimer ou
                vous opposer à un traitement :{" "}
                <MailLink
                  to="privacy"
                  subject="Demande concernant mes données"
                />
                .
              </p>
              <p>
                Écrivez depuis l&apos;adresse de votre compte. Les droits et
                leur fonctionnement sont détaillés dans la{" "}
                <Link href="/confidentialite">
                  politique de confidentialité
                </Link>
                .
              </p>
            </>
          ),
        },
        {
          id: "autres",
          title: "Autres demandes et implantations",
          content: (
            <>
              <p>
                Questions générales et partenariats : <MailLink to="contact" />.
              </p>
              <p>Implantations :</p>
              <ul>
                {LOCATIONS.map((location) => (
                  <li key={location}>{location}</li>
                ))}
              </ul>
              {/* À AJOUTER : téléphone (annoncé ultérieurement). */}
              <p>
                Les e-mails automatiques (confirmation d&apos;adresse,
                réinitialisation du mot de passe) sont envoyés depuis une
                adresse du domaine <span translate="no">{SITE.domain}</span>.
                N&apos;y répondez pas : écrivez plutôt aux adresses ci-dessus.
              </p>
              {/* Expéditeur réel : configuration EMAIL_FROM existante (adresse
              du domaine vérifié chez Resend), non lue dans ce lot. */}
            </>
          ),
        },
      ]}
    />
  );
}
