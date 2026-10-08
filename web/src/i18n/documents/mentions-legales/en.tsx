import { MailLink } from "@/components/legal/mail-link";
import {
  LOCATIONS,
  OPERATOR,
  PROVIDERS,
  SITE,
} from "@/lib/legal/site-identity";
import type { DocumentContent } from "@/i18n/documents/types";
import { PROVIDER_ROLES_EN } from "@/i18n/documents/providers";

// 1-16G — Traduction anglaise fidèle des mentions légales 0.2 (aucune
// coordonnée ajoutée ; implantations écrites telles que déclarées).
// Statut « projet », `noindex`.
const content: DocumentContent = {
  metaTitle: "Legal notice",
  metaDescription:
    "Operator, locations, contacts, hosting and intellectual property of the Stock Master service.",
  title: "Legal notice",
  intro: (
    <p>
      This page states who operates the {SITE.name} service, available at{" "}
      <span translate="no">{SITE.url}</span>, and how to contact them.
    </p>
  ),
  sections: [
    {
      id: "exploitant",
      title: "Service operator",
      content: (
        <>
          <ul>
            <li>
              Name: <strong>{OPERATOR.legalName}</strong>
            </li>
            <li>Trade name: {OPERATOR.tradeName}</li>
            <li>Operator: business established in Cameroon</li>
          </ul>
          <h3>Locations</h3>
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
      title: "Contact us",
      content: (
        <>
          <ul>
            <li>
              General questions: <MailLink to="contact" />
            </li>
            <li>
              Support and complaints: <MailLink to="support" />
            </li>
            <li>
              Personal data: <MailLink to="privacy" />
            </li>
          </ul>
          <p>
            Automatic emails (confirmation link, password reset) are sent from
            an address on the <span translate="no">{SITE.domain}</span> domain
            and must not be replied to.
          </p>
        </>
      ),
    },
    {
      id: "hebergement",
      title: "Hosting",
      content: (
        <>
          <p>
            The domain name <span translate="no">{SITE.domain}</span> is
            registered with Namecheap. The application relies on the following
            technical providers:
          </p>
          <ul>
            {PROVIDERS.map((p) => (
              <li key={p.name}>
                <span translate="no">{p.name}</span>:{" "}
                {(PROVIDER_ROLES_EN[p.name] ?? p.role).toLowerCase()}
              </li>
            ))}
          </ul>
        </>
      ),
    },
    {
      id: "propriete",
      title: "Intellectual property",
      content: (
        <>
          <p>
            The {SITE.name} name, logo, texts, screens and code of the service
            may not be reproduced or reused without the operator&apos;s written
            permission.
          </p>
          <p>
            Content added by shops (product names, photos, logos) remains the
            property of those who publish it. The Terms of Use specify what each
            party may do with it.
          </p>
        </>
      ),
    },
  ],
};

export default content;
