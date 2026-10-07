import Link from "next/link";
import { MailLink } from "@/components/legal/mail-link";
import { OPERATOR, PROVIDERS, SITE } from "@/lib/legal/site-identity";
import type { DocumentContent } from "@/i18n/documents/types";
import { PROVIDER_ROLES_EN } from "@/i18n/documents/providers";

// 1-16G — Traduction anglaise fidèle de l'accord de traitement des données
// 0.3 (aucun engagement ajouté). Statut « projet », `noindex`.
const content: DocumentContent = {
  metaTitle: "Data Processing Agreement",
  metaDescription:
    "Stock Master's commitments when it processes, on behalf of a shop, the data that the shop records.",
  title: "Data Processing Agreement",
  intro: (
    <p>
      When your shop records information in {SITE.name} (sales, buyers, members,
      photos), your shop decides how it is used and {SITE.name} processes it on
      the shop&apos;s behalf. Law No. 2024/017 then requires a contract between
      the two (section 30). This agreement sets out its content.
    </p>
  ),
  sections: [
    {
      id: "parties",
      title: "Parties and roles",
      content: (
        <ul>
          <li>
            <strong>The shop</strong> that is a customer of {SITE.name},
            represented by its owner, is the controller of the data it records.
          </li>
          <li>
            <strong>The operator of {SITE.name}</strong> ({OPERATOR.legalName})
            is the processor for this data.
          </li>
          <li>
            For account data (name, email, password, subscription,
            notifications, support requests), the operator is the controller:
            the <Link href="/confidentialite">Privacy Policy</Link> applies.
          </li>
        </ul>
      ),
    },
    {
      id: "objet",
      title: "Data and people concerned",
      content: (
        <table>
          <caption className="sr-only">Data processed for the shop</caption>
          <thead>
            <tr>
              <th scope="col">People</th>
              <th scope="col">Data</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>The shop&apos;s buyers</td>
              <td>
                Name and contact details, only if the shop enters them in a sale
              </td>
            </tr>
            <tr>
              <td>The shop&apos;s members</td>
              <td>
                Sales recorded by each member, actions on the catalogue and
                stock (history), rankings in the analytics
              </td>
            </tr>
            <tr>
              <td>Anyone visible in an image</td>
              <td>Product photos and logo uploaded by the shop</td>
            </tr>
          </tbody>
        </table>
      ),
    },
    {
      id: "instructions",
      title: "Processing on instructions",
      content: (
        <>
          <p>
            {SITE.name} processes this data only to provide the service to the
            shop: record, display, calculate the analytics, synchronise sales
            entered without a connection and send the chosen notifications. The
            settings made in the application (members, rights, notifications,
            deletions) are the shop&apos;s instructions.
          </p>
          <p>
            {SITE.name} does not use this data for its own purposes, does not
            sell it and does not share it with other shops. If an instruction
            appears to be against the law, {SITE.name} informs the shop.
          </p>
        </>
      ),
    },
    {
      id: "confidentialite",
      title: "Confidentiality",
      content: (
        <p>
          Only the people who act for {SITE.name} and who need it for the
          service may access this data, on its instructions (section 24).
        </p>
      ),
    },
    {
      id: "securite",
      title: "Security",
      content: (
        <>
          <p>Measures in place today:</p>
          <ul>
            <li>
              separation of each shop&apos;s data, checked by the server for
              every request;
            </li>
            <li>
              rights per member, defined by the shop and checked by the server;
            </li>
            <li>hashed passwords and sensitive links, time-limited links;</li>
            <li>history of actions on products and sales;</li>
            <li>
              deletion of the image file when a product is permanently deleted.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "sous-traitants",
      title: "Sub-processors",
      content: (
        <>
          <p>
            The shop authorises {SITE.name} to use the following providers to
            host the service and send its emails:
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
      id: "incidents",
      title: "Security incidents",
      content: (
        <p>
          In the event of a data breach affecting the shop, {SITE.name} informs
          it without delay, with what it knows about the incident, so that the
          shop can meet its own obligations (section 22).
        </p>
      ),
    },
    {
      id: "assistance",
      title: "Help for the shop",
      content: (
        <>
          <p>
            {SITE.name} helps the shop answer people who exercise their rights
            (access, correction, erasure) over data it has recorded. The request
            is made to <MailLink to="privacy" />.
          </p>
          <p>
            In the application, the shop can already correct or delete a sale,
            remove a member&apos;s access and permanently delete a product and
            its photo.
          </p>
        </>
      ),
    },
    {
      id: "fin",
      title: "Return and deletion",
      content: (
        <p>
          The application does not yet offer a full export of a shop&apos;s
          data, nor deletion of a shop by its owner. The owner and the
          administrator can download each month&apos;s sales history (Excel or
          PDF) from Analytics.
        </p>
      ),
    },
    {
      id: "documentation",
      title: "Documentation and audit",
      content: (
        <p>
          The law requires {SITE.name} to keep a record of processing activities
          (section 29), to be presented to the Authority.
        </p>
      ),
    },
  ],
};

export default content;
