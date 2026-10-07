import { CONTACT_EMAILS } from "@/lib/legal/site-identity";

// 1-16C — Lien e-mail vers une adresse centralisée (jamais saisie en dur).
export function MailLink({
  to,
  subject,
}: {
  to: keyof typeof CONTACT_EMAILS;
  subject?: string;
}) {
  const address = CONTACT_EMAILS[to];
  const href = subject
    ? `mailto:${address}?subject=${encodeURIComponent(subject)}`
    : `mailto:${address}`;
  return (
    <a href={href} translate="no" className="break-all">
      {address}
    </a>
  );
}
