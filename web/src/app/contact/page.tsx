import { DocumentPage } from "@/components/legal/document-page";
import { documentMetadata } from "@/lib/legal/document-metadata";
import { getRequestLocale } from "@/i18n/server";
import en from "@/i18n/documents/contact/en";
import fr from "@/i18n/documents/contact/fr";

// 1-16G — Texte dans la langue de la requête : `i18n/documents/contact/`.
const CONTENT = { fr, en } as const;

export async function generateMetadata() {
  const content = CONTENT[await getRequestLocale()];
  return documentMetadata(content.metaTitle, content.metaDescription);
}

export default async function ContactPage() {
  const content = CONTENT[await getRequestLocale()];
  return (
    <DocumentPage
      title={content.title}
      intro={content.intro}
      sections={content.sections}
    />
  );
}
