import Link from "next/link";
import { MailLink } from "@/components/legal/mail-link";
import {
  LOCATIONS,
  OPERATOR,
  PROVIDERS,
  SITE,
} from "@/lib/legal/site-identity";
import type { DocumentContent } from "@/i18n/documents/types";
import { PROVIDER_ROLES_EN } from "@/i18n/documents/providers";

// 1-16G — Traduction anglaise fidèle de la politique de confidentialité
// 0.4 (la 0.3, archivée en français, n'est pas traduite) (aucune clause, promesse ni coordonnée ajoutée ; les implantations
// restent écrites telles que déclarées). Statut « projet », `noindex`. Les
// points « À COMPLÉTER / À VALIDER » du texte français restent ouverts. La
// traduction ne vaut pas validation juridique.
const content: DocumentContent = {
  metaTitle: "Privacy Policy",
  metaDescription:
    "Data processed by Stock Master, purposes, recipients, retention, security and people's rights.",
  title: "Privacy Policy",
  intro: (
    <p>
      This page explains which data {SITE.name} processes, why, with whom it is
      shared, how long it is kept and how to exercise your rights. It
      distinguishes the data of your account, managed by {SITE.name}, from the
      data that your shop records in the application, processed on the
      shop&apos;s behalf.
    </p>
  ),
  sections: [
    {
      id: "responsables",
      title: "Who is responsible for your data",
      content: (
        <>
          <h3>Your account data</h3>
          <p>
            For accounts, subscriptions, notifications and the security of the
            service, the data controller is the operator of {SITE.name}:{" "}
            {OPERATOR.legalName}, a business established in Cameroon (locations:{" "}
            {LOCATIONS.join("; ")}).
          </p>
          <h3>Data entered by a shop</h3>
          <p>
            For the products, stock, sales, photos and buyer information that a
            shop records, it is the <strong>shop</strong> that decides how they
            are used: it is responsible for them. {SITE.name} processes them on
            its behalf, as a processor, under the{" "}
            <Link href="/traitement-donnees">Data Processing Agreement</Link>.
          </p>
          <h3>Contact for your data</h3>
          <p>
            <MailLink to="privacy" />.
          </p>
        </>
      ),
    },
    {
      id: "donnees",
      title: "The data processed",
      content: (
        <>
          <h3>Account and login</h3>
          <ul>
            <li>name, email address, date the address was confirmed;</li>
            <li>password, stored only in hashed form (never in plain text);</li>
            <li>
              confirmation and reset links, stored in hashed form, with their
              sending and expiry dates and the number of recent sends;
            </li>
            <li>
              chosen language (French or English), used for the application and
              for the emails and notifications sent to you.
            </li>
          </ul>
          <h3>Acceptance of the terms</h3>
          <ul>
            <li>
              identifier of your account and, where applicable, of the shop
              concerned;
            </li>
            <li>date and time of acceptance, set by the server;</li>
            <li>
              language, versions and digital fingerprints of the accepted texts
              and of this policy as it was presented to you.
            </li>
          </ul>
          <p>
            Reading this policy is not an agreement: it informs you. No optional
            permission (for example for marketing messages) is requested at
            sign-up, and turning on notifications on a device remains a separate
            choice.
          </p>
          <h3>Shop and members</h3>
          <ul>
            <li>shop name, logo, colour, currency, status;</li>
            <li>
              for each member: role, rights, access status, who sent the
              invitation, date joined;
            </li>
            <li>
              invitations: invited email address, proposed role and rights,
              status, expiry date.
            </li>
          </ul>
          <h3>Subscription</h3>
          <ul>
            <li>trial and subscription periods: length, dates, origin;</li>
            <li>
              amount, chosen length, transaction references, status, and the
              payer&apos;s phone number in masked form.
            </li>
          </ul>
          <h3>Notifications</h3>
          <ul>
            <li>in-app notifications: type, date, read status;</li>
            <li>your choices of notification categories, per shop;</li>
            <li>
              if you turn on notifications on a device: the technical address
              and the keys provided by the browser for that device.
            </li>
          </ul>
          <h3>Support requests</h3>
          <ul>
            <li>
              from Organisation, then Support: category, subject and message
              that you write;
            </li>
            <li>
              added automatically by the server: your name and email address,
              the shop&apos;s name and identifier, your role and rights, the
              identifiers of your account and membership, the date, a request
              reference and, if known, the page of the application concerned. No
              sale, no buyer contact, no file, password or token is attached.
            </li>
          </ul>
          <h3>Data entered by the shop</h3>
          <ul>
            <li>categories, products, prices, quantities, photos;</li>
            <li>
              sales: product, quantity, price, date, member who recorded it and,
              if the shop enters them, the buyer&apos;s name and contact
              details;
            </li>
            <li>
              history of actions (who changed what and when) and calculated
              monthly summaries.
            </li>
          </ul>
          <h3>Technical data</h3>
          <ul>
            <li>
              IP address: used to limit repeated login attempts. These counters
              are kept in memory and disappear when the server restarts;
            </li>
          </ul>
          <p>
            What the application keeps on your device is described on the{" "}
            <Link href="/cookies">Cookies and storage on your device</Link>{" "}
            page.
          </p>
        </>
      ),
    },
    {
      id: "finalites",
      title: "Why this data is processed",
      content: (
        <>
          <p>
            Law No. 2024/017 makes prior, free, informed and specific consent
            the rule (section 9). It provides for exceptions, in particular
            compliance with a legal obligation. Each use below therefore has its
            own basis: no global agreement covers all uses.
          </p>
          <table>
            <caption className="sr-only">Purposes and legal bases</caption>
            <thead>
              <tr>
                <th scope="col">Use</th>
                <th scope="col">Proposed basis</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  Create and manage your account, log you in, send confirmation
                  and reset emails
                </td>
                <td>Your consent</td>
              </tr>
              <tr>
                <td>Keep proof of your acceptance of the terms</td>
                <td>
                  Legal obligation: the burden of proving that information was
                  given and accepted lies with the provider (Law No. 2010/021,
                  section 26; Decree No. 2011/1521/PM, section 12).
                </td>
              </tr>
              <tr>
                <td>
                  Run the shop: members, rights, catalogue, sales, analytics
                </td>
                <td>
                  Processing on behalf of the shop, on its instructions (Data
                  Processing Agreement)
                </td>
              </tr>
              <tr>
                <td>
                  Manage the trial and the subscription, keep proof of
                  transactions
                </td>
                <td>
                  Owner&apos;s consent; legal obligation to keep certain
                  transactions (Decree No. 2011/1521/PM, sections 8 and 22).
                </td>
              </tr>
              <tr>
                <td>
                  Secure the service: limit abuse, keep a record of actions on
                  the data
                </td>
                <td>
                  Legal security obligation (Law No. 2024/017, section 27).
                </td>
              </tr>
              <tr>
                <td>Answer your support requests</td>
                <td>Your consent: you choose to write to customer support</td>
              </tr>
              <tr>
                <td>Alert you on your device (push notifications)</td>
                <td>
                  Your specific consent: turned on by you and authorised by the
                  browser. It can be withdrawn at any time.
                </td>
              </tr>
            </tbody>
          </table>
          <p>
            {SITE.name} does not send marketing, does not sell your data and
            does not show advertising. The analytics (revenue, product and
            seller rankings) are calculations made from the sales, for the shop
            that views them.
          </p>
        </>
      ),
    },
    {
      id: "destinataires",
      title: "Who can see the data",
      content: (
        <>
          <ul>
            <li>
              <strong>The members of your shop</strong>, according to the rights
              the shop has given them. A seller without additional rights only
              sees their own sales.
            </li>
            <li>
              <strong>The technical providers</strong> that host the service or
              send its emails, only for this service (list below).
            </li>
            <li>
              <strong>The browser&apos;s notification service</strong> (for
              example Google&apos;s, Mozilla&apos;s or Apple&apos;s), if you
              turn on notifications on a device: it delivers the message to that
              device.
            </li>
            <li>
              <strong>{SITE.name} customer support</strong>, for your support
              requests: the message is sent by Resend to the address{" "}
              <MailLink to="support" />. Its reply reaches you at your
              account&apos;s email address.
            </li>
            <li>
              <strong>An authority</strong>, when the law requires it.
            </li>
          </ul>
          <table>
            <caption className="sr-only">Technical providers</caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Role</th>
              </tr>
            </thead>
            <tbody>
              {PROVIDERS.map((p) => (
                <tr key={p.name}>
                  <td translate="no">{p.name}</td>
                  <td>{PROVIDER_ROLES_EN[p.name] ?? p.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ),
    },
    {
      id: "transferts",
      title: "Data hosted outside Cameroon",
      content: (
        <>
          <p>
            The providers listed above are foreign companies. Your data may
            therefore be hosted or transferred outside Cameroon. The countries
            concerned will be stated as soon as they have been verified.
          </p>
          <p>
            Law No. 2024/017 makes any transfer of data to a foreign State
            subject to prior authorisation from the Personal Data Protection
            Authority (section 32).
          </p>
        </>
      ),
    },
    {
      id: "conservation",
      title: "How long the data is kept",
      content: (
        <>
          <table>
            <caption className="sr-only">Retention periods</caption>
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">Period</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Email address confirmation link</td>
                <td>Valid for 24 hours</td>
              </tr>
              <tr>
                <td>Password reset link</td>
                <td>Valid for 1 hour</td>
              </tr>
              <tr>
                <td>Invitation link</td>
                <td>
                  Valid for 72 hours; the invitation then remains in the
                  shop&apos;s history.
                </td>
              </tr>
              <tr>
                <td>Login on a device</td>
                <td>7 days at most, or until you log out</td>
              </tr>
              <tr>
                <td>
                  Record of a support request (reference, attached context,
                  sending status; neither the subject nor the message)
                </td>
                <td>
                  Expires 30 days after the request. It is then erased by an
                  automatic database clean-up, which runs in the background and
                  may happen a little later. The message received by customer
                  support is kept separately, in its mailbox (next row).
                </td>
              </tr>
              <tr>
                <td>Support message received by customer support</td>
                <td>Kept in the customer support mailbox</td>
              </tr>
              <tr>
                <td>Read notifications</td>
                <td>
                  Deleted 48 hours to 30 days after being read, depending on
                  their type
                </td>
              </tr>
              <tr>
                <td>Notifications on a device</td>
                <td>
                  Until they are turned off. A device that can no longer be
                  reached is turned off automatically.
                </td>
              </tr>
              <tr>
                <td>Account</td>
                <td>As long as the account exists.</td>
              </tr>
              <tr>
                <td>Proof of acceptance of the terms and accepted texts</td>
                <td>
                  Kept as long as the account exists. Nothing is deleted
                  automatically today.
                </td>
              </tr>
              <tr>
                <td>Shop data, sales and history of actions</td>
                <td>
                  As long as the shop uses the service. Nothing is deleted
                  automatically today.
                </td>
              </tr>
              <tr>
                <td>Subscription transactions of at least 20,000 FCFA</td>
                <td>
                  10 years, the period set by Decree No. 2011/1521/PM (section
                  8).
                </td>
              </tr>
            </tbody>
          </table>
          <p>
            Law No. 2024/017 provides that maximum periods are set by a
            framework issued by the Authority (sections 13 and 28). They will be
            adjusted when this framework is published.
          </p>
        </>
      ),
    },
    {
      id: "securite",
      title: "How the data is protected",
      content: (
        <ul>
          <li>passwords and sensitive links stored in hashed form;</li>
          <li>
            confirmation, reset and invitation links with a limited lifetime;
          </li>
          <li>
            each shop&apos;s data kept separate: every request is checked by the
            server for the shop and the member&apos;s rights;
          </li>
          <li>limits on repeated login attempts;</li>
          <li>
            on the device, offline data erased on logout (except sales not yet
            sent).
          </li>
        </ul>
      ),
    },
    {
      id: "violation",
      title: "In the event of an incident",
      content: (
        <p>
          If a data breach is found, Law No. 2024/017 requires the Authority and
          the people concerned to be informed without delay (section 22).
        </p>
      ),
    },
    {
      id: "droits",
      title: "Your rights",
      content: (
        <>
          <p>Law No. 2024/017 allows you in particular to request:</p>
          <ul>
            <li>access to your data and a copy (section 39);</li>
            <li>correction of inaccurate or incomplete data (section 42);</li>
            <li>
              erasure of your data or an end to its distribution (sections 37
              and 38);
            </li>
            <li>
              restriction of processing if its accuracy or use is disputed
              (section 46);
            </li>
            <li>
              to object to processing, in the cases provided for by law (section
              40);
            </li>
            <li>
              the data you provided, in a machine-readable format (section 43);
            </li>
            <li>
              to give instructions for your data after your death (sections 21
              and 45).
            </li>
          </ul>
          <p>
            To exercise these rights, write to{" "}
            <MailLink to="privacy" subject="Request about my data" /> from your
            account&apos;s address. The law requires that your identity can be
            verified (section 42): you may be asked to confirm your request from
            that address.
          </p>
          <p>
            The application does not yet offer a button to download your data or
            delete your account: these requests are handled by email.
          </p>
          <p>
            For data that a shop has recorded about you, for example as a buyer,
            contact that shop first. {SITE.name} helps it answer you.
          </p>
          <p>
            You can also refer the matter to the Personal Data Protection
            Authority (section 53).
          </p>
        </>
      ),
    },
    {
      id: "mineurs",
      title: "Minors",
      content: (
        <p>
          {SITE.name} is intended for shops. Under Law No. 2024/017, the consent
          of a person under 18 is valid only together with that of their parents
          or legal representative (section 9).
        </p>
      ),
    },
    {
      id: "modifications",
      title: "Changes to this policy",
      content: <p>Each version is dated at the top of the page.</p>,
    },
  ],
};

export default content;
