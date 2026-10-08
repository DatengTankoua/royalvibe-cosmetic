import Link from "next/link";
import { MailLink } from "@/components/legal/mail-link";
import { SITE } from "@/lib/legal/site-identity";
import { TRIAL_DAYS } from "@/lib/subscription-offers";
import type { DocumentContent } from "@/i18n/documents/types";

// 1-16G — Guide d'utilisation en anglais. Les noms des boutons sont ceux de
// l'interface anglaise (ressources `i18n/resources/en/*`).
const registrationEnabled =
  process.env.NEXT_PUBLIC_REGISTRATION_ENABLED === "true";

const content: DocumentContent = {
  metaTitle: "User guide",
  metaDescription:
    "Sign-up, shop and members, products, stock, sales, analytics, trash, offline, subscription and notifications: the Stock Master step-by-step guide.",
  title: "User guide",
  intro: (
    <p>
      This guide explains, step by step, how to use {SITE.name} in your shop.
      Button names are written as they appear in the application.
    </p>
  ),
  sections: [
    {
      id: "inscription",
      title: "Sign up and confirm your email address",
      content: (
        <>
          {!registrationEnabled && (
            <p>
              <strong>Online sign-ups are temporarily closed.</strong> The steps
              below will apply when they reopen. An invited seller can still
              join a shop (see the next section).
            </p>
          )}
          <ol>
            <li>
              Open the{" "}
              {registrationEnabled ? (
                <Link href="/auth/register">Sign up</Link>
              ) : (
                "Sign up"
              )}{" "}
              page and enter your name, your email address, a password of 6 to
              100 characters and the name of your shop (20 characters at most).
            </li>
            <li>
              Read and then accept the{" "}
              <Link href="/conditions-utilisation">Terms of Use</Link> and the{" "}
              <Link href="/conditions-abonnement">Subscription Terms</Link> by
              ticking the box provided: the account is not created without it.
            </li>
            <li>
              A confirmation email is sent to you. Open the link it contains
              within 24 hours.
            </li>
            <li>
              You can then <Link href="/auth/login">log in</Link>. The{" "}
              {TRIAL_DAYS}-day free trial started when the shop was created.
            </li>
          </ol>
          <p>
            No email? Check your spam folder, then try to log in: the login
            screen then offers to send the link again. If you forget your
            password, use “Forgot your password?”: the link you receive is valid
            for 1 hour.
          </p>
        </>
      ),
    },
    {
      id: "membres",
      title: "Create your shop, invite members, choose their rights",
      content: (
        <>
          <p>
            Your shop is created when you sign up, and you are its owner. In{" "}
            <strong>Organisation</strong>, you can change its name, logo and
            colour (Branding), and manage the team.
          </p>
          <h3>Invite a member</h3>
          <ol>
            <li>
              Open <strong>Organisation, then Invitations</strong>, and create
              an invitation with the person&apos;s email address, role and
              rights.
            </li>
            <li>
              Copy the link shown and send it yourself, by text message or a
              messaging app. {SITE.name} does not send the invitation by email.
              The link is shown only once and stays valid for 72 hours.
            </li>
            <li>
              The person opens the link and creates their access. If they do not
              have an account yet, they accept the Terms of Use by ticking the
              box provided.
            </li>
          </ol>
          <h3>Roles and rights</h3>
          <ul>
            <li>
              <strong>Owner</strong>: all rights, subscription and transfer of
              ownership.
            </li>
            <li>
              <strong>Administrator</strong>: all rights except those specific
              to the owner.
            </li>
            <li>
              <strong>Seller</strong>: records sales and sees their own. You can
              add other rights one by one (see all sales, manage the catalogue,
              adjust stock, view analytics, contact customer support…).
            </li>
          </ul>
          <p>
            In <strong>Organisation, then Members</strong>, choose “Edit” on a
            member to change their rights or status: “Suspended” removes access
            temporarily, “Revoked” removes it permanently. The owner can also
            “Transfer ownership” to another member.
          </p>
        </>
      ),
    },
    {
      id: "catalogue",
      title: "Products, categories, stock, sales and analytics",
      content: (
        <>
          <h3>Organise products by category</h3>
          <p>
            In <strong>Catalogue</strong>, create your categories with “New
            section” (for example Drinks, Groceries). A category can contain
            sub-categories.
          </p>
          <h3>Add a product</h3>
          <p>
            Open a category, then add a product: name, photo, purchase price,
            sale price and initial quantity (in FCFA). The photo is required.
          </p>
          <h3>Track and top up stock</h3>
          <ul>
            <li>
              Each sale lowers the product&apos;s stock. The product page shows
              “In stock”, “Low stock” or “Out of stock”.
            </li>
            <li>
              To add goods, choose “Edit” on the product and enter the quantity
              added (“Adjust stock” right).
            </li>
          </ul>
          <h3>Record a sale</h3>
          <ol>
            <li>Open the product in the catalogue.</li>
            <li>Choose “Record a sale”.</li>
            <li>
              Enter the quantity and the actual sale price. The buyer&apos;s
              name and contact details are optional: only enter them if your
              shop needs them.
            </li>
            <li>
              Confirm. The sale appears in <strong>Sales</strong>.
            </li>
          </ol>
          <p>
            A sale can be corrected or deleted later, depending on your rights.
            Deleting a sale puts the quantity back in stock.
          </p>
          <h3>Understand your business</h3>
          <p>
            <strong>Analytics</strong> (“View analytics” right) shows the
            capital invested, revenue, profit, margin, units sold, the monthly
            trend and the product and seller rankings. A summary of the past
            month is also produced at the start of each month.
          </p>
          <p>
            When a month is chosen, the card becomes “Estimated gain for the
            month”: amount of the month&apos;s sales minus the current purchase
            price of the products sold that month (price kept when a product is
            deleted). If this price is unknown for a sale of the month, the gain
            is shown as “—” rather than wrong.
          </p>
          <h3>Download a month&apos;s history</h3>
          <ul>
            <li>
              The owner and the administrator find, at the top of{" "}
              <strong>Analytics</strong>, the “Monthly history” block: choose a
              month, then “Download as Excel” or “Download as PDF”.
            </li>
            <li>
              The file contains a summary of the month, all sales (date,
              product, quantity, price, amount, seller, buyer), a summary by
              product and by seller, and the month&apos;s sale corrections and
              cancellations.
            </li>
            <li>
              The figures follow the same rules as the Analytics screen. A
              product&apos;s name is the one recorded at the time of the sale,
              even if it has since been renamed or deleted. An unknown value is
              shown as “Information unavailable”, never zero.
            </li>
            <li>
              Sales still waiting to be synchronised on a device are not
              included: synchronise them before downloading.
            </li>
            <li>
              The PDF reproduces names exactly (accents, œ and apostrophes
              included). If a name contains characters it cannot reproduce
              (another alphabet, emoji…), it is refused with a message: then
              download the Excel file, which keeps names exactly.
            </li>
            <li>
              Downloading needs an Internet connection. The file contains
              information about buyers: keep it somewhere safe.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "corbeille",
      title: "Trash, permanent deletion and sales history",
      content: (
        <>
          <ul>
            <li>
              Deleting a product or a category puts it in the{" "}
              <strong>Trash</strong> (“Move to trash”). Nothing is erased yet:
              you can “Restore” it.
            </li>
            <li>
              In the trash, “Delete permanently” erases the product and its
              photo. This action cannot be undone.
            </li>
            <li>
              The sales history is kept after a permanent deletion: past sales
              keep the product name and are still counted in the analytics.
            </li>
          </ul>
          <p>The trash requires the “Manage trash” right.</p>
        </>
      ),
    },
    {
      id: "hors-ligne",
      title: "Working without a connection",
      content: (
        <>
          <p>
            {SITE.name} lets you keep selling when the network goes down, under
            these conditions:
          </p>
          <ul>
            <li>
              you must have opened the application with network in the{" "}
              <strong>last 72 hours</strong>, on the same device and with the
              same account;
            </li>
            <li>
              without network, only the catalogue and recording sales are
              available. Adding products, viewing analytics or managing the team
              needs a connection;
            </li>
            <li>
              the stock shown without network is a guide only: it does not
              include sales made in the meantime on other devices.
            </li>
          </ul>
          <h3>Synchronisation</h3>
          <ul>
            <li>
              Sales entered without network are marked “pending” and sent
              automatically when the connection comes back.
            </li>
            <li>
              The server checks each sale. If one is refused (not enough stock,
              right removed…), it stays in “Pending sales” so that you can
              correct it.
            </li>
            <li>
              A device keeps at most 200 pending sales, each for 14 days at
              most. If sending is delayed, open “Pending sales” to see the
              reason and correct them or send them again.
            </li>
            <li>Logging out does not delete pending sales.</li>
          </ul>
        </>
      ),
    },
    {
      id: "abonnement",
      title: "Subscription and renewal",
      content: (
        <ul>
          <li>
            The {TRIAL_DAYS}-day trial starts when the shop is created. Its
            status and end date are shown in{" "}
            <strong>Organisation, then Subscription</strong>.
          </li>
          <li>
            Lengths and prices are set out in the{" "}
            <Link href="/conditions-abonnement">Subscription Terms</Link>.
          </li>
          <li>
            Online payment is not available yet. To renew, the owner writes from
            Organisation, then Support (“Subscription” category), or to{" "}
            <MailLink to="support" subject="Subscription renewal" />.
          </li>
          <li>
            When the subscription ends without renewal, access to the shop is
            blocked for all its members. The data is not erased, and pending
            sales stay on the device.
          </li>
        </ul>
      ),
    },
    {
      id: "notifications",
      title: "Notifications, installation and push",
      content: (
        <>
          <h3>Notification centre</h3>
          <p>
            The bell at the top of the application opens your notifications:
            product out of stock or nearly out of stock, new sales, end of trial
            or subscription, payment confirmed, monthly summary. You only
            receive those that match your rights.
          </p>
          <h3>Install the application</h3>
          <ul>
            <li>
              On browsers that allow it (for example Chrome), the “Install”
              button adds {SITE.name} to the home screen.
            </li>
            <li>
              On iPhone and iPad, in Safari: tap Share, then “Add to Home
              Screen”.
            </li>
          </ul>
          <h3>Turn notifications on the device on or off</h3>
          <ol>
            <li>
              Open <strong>Organisation, then Notifications</strong>.
            </li>
            <li>
              Choose “Turn on notifications”, then accept the browser&apos;s
              request.
            </li>
            <li>Tick the categories you are interested in.</li>
            <li>
              To stop, choose “Turn off notifications”. You can also block them
              in the browser settings.
            </li>
          </ol>
          <p>
            The setting applies to this device only. On iPhone and iPad,
            notifications are only offered to the application added to the home
            screen.
          </p>
          <p>
            <strong>Important:</strong> notifications on the device have not yet
            been tested on real Android phones or iPhones. They may not arrive
            on some devices: the application&apos;s notification centre remains
            the reference.
          </p>
        </>
      ),
    },
    {
      id: "aide",
      title: "Need help?",
      content: (
        <>
          <h3>From the application</h3>
          <ol>
            <li>
              Open <strong>Organisation, then Support</strong>.
            </li>
            <li>
              Choose a category (Using the app, Subscription, Technical problem,
              Other), then write a subject and your message.
            </li>
            <li>
              Check the “Information sent to customer support” block: your name,
              email, shop, role and identifiers are attached automatically to
              find your account. No sale and no buyer contact is attached.
            </li>
            <li>
              Choose “Send to customer support”. A request reference is shown:
              write it down. The reply arrives at your email address.
            </li>
          </ol>
          <p>
            Sending needs an Internet connection. If it fails, your text stays
            on the screen: try again without retyping it. The owner and the
            administrators have access to Support; a seller only if they have
            been given the “Contact customer support” right.
          </p>
          <h3>By email</h3>
          <p>
            If you cannot access your shop, write to <MailLink to="support" />{" "}
            stating the name of your shop, the screen concerned and what you
            tried. The other contacts are on the{" "}
            <Link href="/contact">Contact</Link> page.
          </p>
        </>
      ),
    },
  ],
};

export default content;
