import Link from "next/link";
import { MailLink } from "@/components/legal/mail-link";
import { OPERATOR, SITE } from "@/lib/legal/site-identity";
import type { DocumentContent } from "@/i18n/documents/types";

// 1-16G — Traduction anglaise fidèle des conditions d'utilisation 0.3
// (aucune clause, promesse ni coordonnée ajoutée). Même statut « projet »,
// même `noindex`. La traduction ne vaut pas validation juridique.
// Les points « À COMPLÉTER » du texte français restent ouverts.
const content: DocumentContent = {
  metaTitle: "Terms of Use",
  metaDescription:
    "Rules for using the Stock Master service: accounts, shops, roles, security, availability and suspension.",
  title: "Terms of Use",
  intro: (
    <p>
      These terms explain how to use {SITE.name}, what you can expect from the
      service and what is expected of you. They apply to anyone who creates an
      account or joins a shop. The rules specific to the subscription are set
      out in the <Link href="/conditions-abonnement">Subscription Terms</Link>.
    </p>
  ),
  sections: [
    {
      id: "service",
      title: "The service",
      content: (
        <>
          <p>
            {SITE.name} is an online stock and sales management application,
            designed for shops and small businesses. It is used in the browser
            of a phone, tablet or computer. In particular, it lets you:
          </p>
          <ul>
            <li>organise your products by category and track your stock;</li>
            <li>
              record sales, including without a connection within the limits
              described in the guide;
            </li>
            <li>invite members and choose their rights;</li>
            <li>view analytics calculated from the sales;</li>
            <li>
              receive notifications in the application and, if you turn them on,
              on the device.
            </li>
          </ul>
          <p>
            The service is operated by {OPERATOR.legalName}, a business
            established in Cameroon (see the{" "}
            <Link href="/mentions-legales">Legal notice</Link>).
          </p>
        </>
      ),
    },
    {
      id: "acces",
      title: "Who can use Stock Master",
      content: (
        <>
          <p>
            {SITE.name} is intended for professional use: managing a shop&apos;s
            business. To create an account, you must be able to commit on your
            own behalf or on behalf of the shop you represent.
          </p>
          <p>
            Online sign-ups may be closed temporarily. In that case, only
            existing accounts and people invited by a shop can access the
            service.
          </p>
        </>
      ),
    },
    {
      id: "compte",
      title: "Your account",
      content: (
        <>
          <ul>
            <li>
              You provide a name, an email address that you actually use, and a
              password of 6 to 100 characters. Choose a password that you do not
              use anywhere else.
            </li>
            <li>
              The email address must be confirmed with the link you receive
              before the first login. This link is valid for 24 hours.
            </li>
            <li>
              The account is personal: do not share your login details. Each
              seller must have their own account, which makes it possible to
              know who recorded each sale.
            </li>
            <li>
              A login stays open on the device until you log out or it expires
              (at most 7 days). Log out on a shared device.
            </li>
          </ul>
          <p>
            Changing your name or email address and deleting your account are
            not yet available in the application. For these requests, write to{" "}
            <MailLink to="support" />.
          </p>
        </>
      ),
    },
    {
      id: "commerces",
      title: "Shops, roles and responsibilities",
      content: (
        <>
          <p>
            When you sign up, you create a shop of which you become the{" "}
            <strong>owner</strong>. In each shop, a member has one of these
            roles:
          </p>
          <ul>
            <li>
              <strong>Owner</strong>: all rights, including the subscription and
              transferring ownership to another member.
            </li>
            <li>
              <strong>Administrator</strong>: all rights that can be delegated
              (catalogue, stock, sales, analytics, trash, members, shop
              branding).
            </li>
            <li>
              <strong>Seller</strong>: records sales and sees their own. The
              owner or an administrator can add other rights one by one.
            </li>
          </ul>
          <p>The owner of the shop, and the administrators for their part:</p>
          <ul>
            <li>decide who joins the shop and with which rights;</li>
            <li>
              remove access for a member who should no longer have it
              (“Suspended” or “Revoked” status);
            </li>
            <li>
              are responsible for the information entered in the shop: products,
              prices, stock, sales, photos and, where applicable, a buyer&apos;s
              name or contact details.
            </li>
          </ul>
          <p>
            When you record information about your own customers, it is your
            shop that decides how it is used. {SITE.name} processes it on your
            behalf, under the conditions of the{" "}
            <Link href="/traitement-donnees">Data Processing Agreement</Link>.
          </p>
        </>
      ),
    },
    {
      id: "usage",
      title: "Permitted use",
      content: (
        <>
          <p>You agree not to:</p>
          <ul>
            <li>use the service for an illegal activity;</li>
            <li>
              try to access another shop&apos;s data or functions for which you
              have not been given a right;
            </li>
            <li>
              disrupt the service, deliberately overload it, or query it in an
              automated way without agreement;
            </li>
            <li>
              upload images you do not have the rights to, or content that is
              against the law;
            </li>
            <li>
              record information about people when it is not needed for your
              business.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "securite",
      title: "Security",
      content: (
        <>
          <p>
            {SITE.name} protects access to the service: passwords stored in
            encrypted form (hashing), confirmation and invitation links with a
            limited lifetime, each shop&apos;s data kept separate from the
            others, rights checked by the server for every action. The{" "}
            <Link href="/confidentialite">Privacy Policy</Link> describes these
            measures.
          </p>
          <p>On your side:</p>
          <ul>
            <li>keep your password secret;</li>
            <li>
              report without delay to <MailLink to="support" /> any access you
              did not authorise;
            </li>
            <li>
              on a shared device, log out and delete the offline data
              (Organisation, then Offline).
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "disponibilite",
      title: "Availability and changes to the service",
      content: (
        <>
          <p>
            {SITE.name} does what is necessary to keep the service accessible
            and your data stored. Interruptions may occur, in particular for
            maintenance or if a provider has an outage.
          </p>
          <p>
            The service changes over time: functions may be added or modified.
          </p>
        </>
      ),
    },
    {
      id: "suspension",
      title: "Suspension and ending use",
      content: (
        <>
          <p>
            You can stop using {SITE.name} at any time. The effects on the
            current subscription are described in the{" "}
            <Link href="/conditions-abonnement">Subscription Terms</Link>.
          </p>
          <p>
            Access to an account or a shop may be suspended in the event of a
            serious breach of these terms, a threat to the security of the
            service or a request from an authority.
          </p>
        </>
      ),
    },
    {
      id: "propriete",
      title: "Intellectual property",
      content: (
        <p>
          You may use {SITE.name} for your shop&apos;s needs for as long as you
          have access. The content you add remains yours: you only allow{" "}
          {SITE.name} to store it and to display it to the members of your shop,
          for the sole purpose of providing the service.
        </p>
      ),
    },
    {
      id: "reclamations",
      title: "Complaints and applicable rights",
      content: (
        <>
          <p>
            For a complaint, write to <MailLink to="support" /> stating the shop
            concerned and the problem encountered, or use Organisation, then
            Support. All contact details are on the{" "}
            <Link href="/contact">Contact</Link> page.
          </p>
          <p>
            These terms do not reduce any right that the law gives you, in
            particular as a consumer or as a person whose data is processed. A
            clause contrary to these rights would have no effect.
          </p>
        </>
      ),
    },
    {
      id: "acceptation",
      title: "Acceptance of these terms",
      content: (
        <>
          <p>
            You accept these terms by ticking the box provided when you create
            your account, whether you create a shop or join a shop by
            invitation. This box is never ticked in advance, and the account is
            not created without it.
          </p>
          <p>
            The {SITE.name} server then records the proof of your acceptance:
            your account, the shop concerned, the date and time set by the
            server, the language, the version of the text and its digital
            fingerprint. This fingerprint makes it possible to find the exact
            text you accepted. Each accepted version is archived, and a new
            version replaces neither the previous texts nor the proofs already
            recorded.
          </p>
          <p>
            If your account existed before this acceptance was put in place, or
            if a new version concerns you, your agreement will be requested in
            the application. No acceptance is recorded on your behalf.
          </p>
        </>
      ),
    },
    {
      id: "modifications",
      title: "Changes to the terms",
      content: (
        <>
          <p>
            Each version is dated. A significant change will be announced before
            it comes into force, and the applicable version will remain
            available on this page.
          </p>
          <p>Language: this text was written in French.</p>
        </>
      ),
    },
  ],
};

export default content;
