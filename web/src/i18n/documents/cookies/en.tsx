import Link from "next/link";
import { SITE } from "@/lib/legal/site-identity";
import type { DocumentContent } from "@/i18n/documents/types";

// 1-16G — Traduction anglaise fidèle de « Cookies et stockage sur
// l'appareil » 0.5 (1-16H : clés de session `stockmaster_*`). Les noms
// techniques (clés, bases) ne sont pas traduits.
// Statut « projet », `noindex`.
type Row = { name: string; purpose: string; duration: string };

function StorageTable({ caption, rows }: { caption: string; rows: Row[] }) {
  return (
    <table>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th scope="col">What it is for</th>
          <th scope="col">Duration</th>
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

const content: DocumentContent = {
  metaTitle: "Cookies and storage on your device",
  metaDescription:
    "What Stock Master stores in the browser, what it is for and how to delete it.",
  title: "Cookies and storage on your device",
  intro: (
    <p>
      {SITE.name} uses <strong>only one cookie</strong>, which remembers the
      chosen language, and no audience measurement or advertising. To work, the
      application also stores some information in your device&apos;s browser.
      This page lists all of it.
    </p>
  ),
  sections: [
    {
      id: "principe",
      title: "What is stored and why",
      content: (
        <>
          <p>
            All the items below are needed for the service you request: staying
            logged in, working without a connection, finding a payment in
            progress or not seeing a message you already closed again. None is
            used to track you on other sites or to measure your browsing.
          </p>
          <p>
            This information stays on your device. Only the login token and the
            pending sales are sent to the {SITE.name} server, to identify you
            and record the sales. The language cookie is sent to the site with
            each page, to display it in the chosen language.
          </p>
        </>
      ),
    },
    {
      id: "cookie",
      title: "Cookie",
      content: (
        <StorageTable
          caption="Cookie"
          rows={[
            {
              name: "stockmaster.lang",
              purpose:
                "Language chosen with the “Français / English” button (fr or en). Set only when you choose a language; without it, the page is shown in the browser's language, otherwise in French.",
              duration: "365 days, renewed with each choice",
            },
          ]}
        />
      ),
    },
    {
      id: "local",
      title: "Browser storage (localStorage and sessionStorage)",
      content: (
        <StorageTable
          caption="Local and session storage"
          rows={[
            {
              name: "stockmaster_token",
              purpose: "Login token: keeps you logged in.",
              duration:
                "Until you log out; the token expires after 7 days at the latest",
            },
            {
              name: "stockmaster_user",
              purpose:
                "Name, email address and identifier of the logged-in account, for display.",
              duration: "Until you log out",
            },
            {
              name: "stockmaster_restricted_session",
              purpose:
                "Limited access when the subscription has expired, while it is being renewed (current tab only).",
              duration: "15 minutes, erased when the tab is closed",
            },
            {
              name: "stockmaster_commercial_blocks",
              purpose:
                "Remembers that a shop is blocked by the subscription (identifiers only), so that the block stays displayed without a connection.",
              duration: "Until access is restored",
            },
            {
              name: "stockmaster_payment_intents",
              purpose:
                "Finds a subscription payment in progress after an interruption (unused while online payment is closed).",
              duration: "Until the payment is finished",
            },
            {
              name: "stockmaster.theme",
              purpose:
                "Display theme chosen on this device (light or dark). Absent in automatic mode, which follows the device setting.",
              duration: "No limit, you can erase it",
            },
            {
              name: "stockmaster.pwa.installed",
              purpose:
                "Remembers that the application was installed on the device.",
              duration: "No limit, you can erase it",
            },
            {
              name: "stockmaster.engagement.lastModalAt",
              purpose:
                "Date of the last message offering notifications or installation, so that it is not repeated.",
              duration: "No limit, you can erase it",
            },
            {
              name: "stockmaster.engagement.bannerHidden",
              purpose:
                "Remembers that this message was closed during the visit.",
              duration: "Until the tab is closed",
            },
          ]}
        />
      ),
    },
    {
      id: "hors-ligne",
      title: "Offline data (IndexedDB)",
      content: (
        <>
          <StorageTable
            caption="IndexedDB databases"
            rows={[
              {
                name: "stockmaster-offline-catalog",
                purpose:
                  "Copy of the catalogue (names, sale prices, remaining stock; never the purchase price), to view and sell without network.",
                duration: "Usable for 72 hours; erased when you log out",
              },
              {
                name: "stockmaster-offline-identity",
                purpose:
                  "Identifiers of the current account and shop, to reopen the application without network.",
                duration: "Erased when you log out",
              },
              {
                name: "stockmaster-offline-sales-capability",
                purpose:
                  "Only indicates whether you have the right to record sales.",
                duration: "72 hours; erased when you log out",
              },
              {
                name: "stockmaster-offline-tenant-brand",
                purpose: "Shop name and colour, for display without network.",
                duration: "Erased when you log out",
              },
              {
                name: "stockmaster-preferences",
                purpose:
                  "Language chosen on this device (fr or en), for the message the application shows itself when a notification cannot be displayed.",
                duration: "No limit, you can erase it",
              },
              {
                name: "stockmaster-offline-sales-outbox",
                purpose:
                  "Sales recorded without a connection, waiting to be sent. May contain a buyer's name and contact details if they were entered.",
                duration:
                  "Until sent; at most 14 days pending; kept 7 days after sending",
              },
            ]}
          />
          <p>
            Pending sales are <strong>not</strong> erased when you log out, so
            that no sale is lost. They can still be viewed from the pending
            sales page.
          </p>
        </>
      ),
    },
    {
      id: "cache",
      title: "Application cache (service worker)",
      content: (
        <p>
          To open without network, the application keeps a copy of its public
          files: home, login and sign-up pages, offline page, catalogue page,
          icons, logo and the application code. This cache contains neither your
          account data nor the shop&apos;s, and never stores confirmation,
          invitation or reset links.
        </p>
      ),
    },
    {
      id: "tiers",
      title: "Content loaded from other services",
      content: (
        <ul>
          <li>
            Product photos and logos are loaded from the site&apos;s storage
            service (Supabase). As with any online image, this service receives
            the device&apos;s IP address.
          </li>
          <li>
            If you turn on notifications, the browser registers with its own
            notification service.
          </li>
          <li>
            No social network, advertising or audience measurement script is
            loaded.
          </li>
        </ul>
      ),
    },
    {
      id: "consentement",
      title: "Is your agreement needed?",
      content: (
        <>
          <p>
            As all these items (including the language cookie) are needed for
            the service requested and none is used for advertising or audience
            measurement, no consent window is shown. There is no optional use
            today.
          </p>
          <p>
            Notifications on the device are never turned on without your action:
            you turn them on in the application, then the browser asks for its
            own permission.
          </p>
        </>
      ),
    },
    {
      id: "supprimer",
      title: "How to delete everything",
      content: (
        <ul>
          <li>
            <strong>Logging out</strong> erases the login token and the offline
            data, except sales not yet sent.
          </li>
          <li>
            In the application,{" "}
            <strong>
              Organisation, then Offline, then “Delete offline data”
            </strong>{" "}
            erases the same data without logging you out.
          </li>
          <li>
            In the browser settings, clearing the data of the site{" "}
            <span translate="no">{SITE.domain}</span> deletes everything,
            including pending sales: wait until they are sent first.
          </li>
          <li>
            To stop notifications on a device, see the{" "}
            <Link href="/guide#notifications">guide</Link>.
          </li>
        </ul>
      ),
    },
  ],
};

export default content;
