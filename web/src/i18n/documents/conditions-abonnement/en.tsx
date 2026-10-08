import Link from "next/link";
import { MailLink } from "@/components/legal/mail-link";
import { SITE } from "@/lib/legal/site-identity";
import {
  SUBSCRIPTION_OFFERS,
  TRIAL_DAYS,
  formatFcfa,
  monthlyEquivalentXaf,
} from "@/lib/subscription-offers";
import type { DocumentContent } from "@/i18n/documents/types";
import subscriptionEn from "@/i18n/resources/en/subscription";

// 1-16G — Traduction anglaise fidèle des conditions d'abonnement 0.4 (la
// version 0.3, archivée en français, n'est jamais traduite). Mêmes tarifs,
// lus dans `lib/subscription-offers.ts`. Statut « projet », `noindex`. La
// traduction ne vaut pas validation juridique.
const TERM_LABELS = subscriptionEn.offers.term;

const content: DocumentContent = {
  metaTitle: "Subscription Terms",
  metaDescription:
    "Free trial, lengths and prices in FCFA, activation, expiry, renewal and complaints for the Stock Master subscription.",
  title: "Subscription Terms",
  intro: (
    <p>
      These terms describe the free trial and the paid subscription to{" "}
      {SITE.name}: what they include, how long they last, their price and what
      happens when they end. They supplement the{" "}
      <Link href="/conditions-utilisation">Terms of Use</Link>.
    </p>
  ),
  sections: [
    {
      id: "offre",
      title: "What the subscription includes",
      content: (
        <>
          <p>
            There is a single offer, with all the functions of {SITE.name}. The
            subscription is taken out for a shop, not for a person:
          </p>
          <ul>
            <li>
              all members of the shop are included, with no extra charge per
              seller;
            </li>
            <li>
              each member accesses the functions according to the rights the
              shop has given them;
            </li>
            <li>
              the subscription is managed by the shop owner, in Organisation,
              then Subscription.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "essai",
      title: "Free trial",
      content: (
        <ul>
          <li>
            A free trial of {TRIAL_DAYS} days starts automatically when the shop
            is created.
          </li>
          <li>No means of payment is requested for the trial.</li>
          <li>A shop is entitled to only one trial.</li>
          <li>
            If the “End of trial or subscription” notifications are turned on, a
            reminder is sent within the 24 hours before the end.
          </li>
          <li>
            At the end of the trial, access to the shop is limited as described
            in the “Expiry” section.
          </li>
        </ul>
      ),
    },
    {
      id: "prix",
      title: "Lengths and prices",
      content: (
        <>
          <p>
            The amount shown is the total to pay for the chosen length, in CFA
            francs (XAF).
          </p>
          <table>
            <caption className="sr-only">
              Subscription lengths and prices
            </caption>
            <thead>
              <tr>
                <th scope="col">Length</th>
                <th scope="col">Total</th>
                <th scope="col">Monthly equivalent</th>
              </tr>
            </thead>
            <tbody>
              {SUBSCRIPTION_OFFERS.map((offer) => (
                <tr key={offer.term}>
                  <td>{TERM_LABELS[offer.term]}</td>
                  <td className="whitespace-nowrap tabular-nums">
                    {formatFcfa(offer.totalXaf, "en")}
                  </td>
                  <td className="tabular-nums">
                    {offer.months > 1
                      ? `${formatFcfa(monthlyEquivalentXaf(offer), "en")} (${formatFcfa(offer.savingXaf, "en")} saved)`
                      : "Pay month by month"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            The applicable price is the one displayed when the period is
            granted. A period already granted is never changed by a price
            change.
          </p>
        </>
      ),
    },
    {
      id: "duree",
      title: "Start and length of a period",
      content: (
        <ul>
          <li>
            A period is counted in calendar months: a one-month period started
            on 10 March ends on 10 April at the same time. If the day does not
            exist (31st), it ends on the last day of the month.
          </li>
          <li>
            A period granted before the end of the trial or of the current
            period starts at the end of that period: time already granted is
            never lost.
          </li>
          <li>
            The subscription status and its dates are shown in Organisation,
            then Subscription.
          </li>
        </ul>
      ),
    },
    {
      id: "renouvellement",
      title: "Payment and renewal",
      content: (
        <>
          <p>
            Online payment is not yet available. For any renewal request,
            contact <MailLink to="support" subject="Subscription renewal" />.
          </p>
          <ul>
            <li>
              There is no automatic renewal or automatic payment: each new
              period is the owner&apos;s decision.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "expiration",
      title: "Expiry",
      content: (
        <>
          <p>
            At the end of the trial or of the last paid period, without a new
            period:
          </p>
          <ul>
            <li>
              access to the shop&apos;s pages is blocked for all its members,
              including on devices already logged in;
            </li>
            <li>
              the owner sees a screen inviting them to renew; the other members
              are asked to contact the owner;
            </li>
            <li>
              sales recorded without a connection and not yet sent stay on the
              device; they are sent when access is restored, within 14 days of
              being entered;
            </li>
            <li>
              the shop&apos;s data is not deleted automatically on expiry.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "resiliation",
      title: "Stopping, withdrawal and refunds",
      content: (
        <p>
          As nothing is renewed automatically, simply not renewing is enough to
          stop the subscription at the end of the current period.
        </p>
      ),
    },
    {
      id: "acceptation",
      title: "Who accepts these terms",
      content: (
        <>
          <p>
            These terms bind the person who creates the shop and becomes its
            owner. They accept them by ticking the box provided at sign-up,
            together with the Terms of Use. This box is never ticked in advance.
          </p>
          <p>
            Invited administrators and sellers accept the Terms of Use, not
            these terms. After a transfer of ownership, the new owner&apos;s
            agreement will be requested in the application.
          </p>
          <p>
            The proof of acceptance is recorded by the server as described in
            the{" "}
            <Link href="/conditions-utilisation#acceptation">Terms of Use</Link>
            , together with the shop concerned.
          </p>
        </>
      ),
    },
    {
      id: "reclamations",
      title: "Complaints",
      content: (
        <>
          <p>
            For any question or complaint about the trial, a period or a
            payment, write to <MailLink to="support" /> stating the name of the
            shop and the owner&apos;s email address.
          </p>
          <p>These terms do not reduce any right that the law gives you.</p>
        </>
      ),
    },
  ],
};

export default content;
