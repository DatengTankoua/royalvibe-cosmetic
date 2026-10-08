import type legalFr from "../fr/legal";
import type { Translation } from "../types";

const legalEn: Translation<typeof legalFr> = {
  document: {
    skipToContent: "Skip to content",
    version: "Version {{version}}, updated on {{date}}.",
    toc: "Contents",
    question:
      "A question about this text? <contact>Contact Stock Master</contact>",
  },
  documents: {
    "mentions-legales": {
      title: "Legal notice",
      short: "Legal notice",
      inSentence: "Legal notice",
    },
    "conditions-utilisation": {
      title: "Terms of Use",
      short: "Terms of Use",
      inSentence: "Terms of Use",
    },
    "conditions-abonnement": {
      title: "Subscription Terms",
      short: "Subscription Terms",
      inSentence: "Subscription Terms",
    },
    confidentialite: {
      title: "Privacy Policy",
      short: "Privacy",
      inSentence: "Privacy Policy",
    },
    cookies: {
      title: "Cookies and storage on your device",
      short: "Cookies and storage",
      inSentence: "Cookies and storage policy",
    },
    "traitement-donnees": {
      title: "Data Processing Agreement",
      short: "Data processing",
      inSentence: "Data Processing Agreement",
    },
  },
  acceptance: {
    prefix: "I have read and accept",
    article: "the",
    and: " and ",
    comma: ", ",
    newTab: "(new tab)",
    versions_one: "(version {{versions}})",
    versions_other: "(versions {{versions}})",
    notice:
      "To find out which data is processed and why, read the <doc></doc> (version {{version}}). It is for your information: reading it is not an agreement.",
    errors: {
      required: "Tick the box to accept the terms before continuing.",
      outdated:
        "The terms have been updated. Reload the page to read the new version, then try again.",
      mismatch:
        "The terms shown do not match the texts in force. Reload the page, then try again.",
      archive:
        "Your acceptance cannot be recorded at the moment. Try again in a few moments.",
    },
  },
  prompt: {
    title: "Your agreement is needed",
    description:
      "Before you continue using Stock Master, read the texts below. Your agreement is recorded only if you tick the box and confirm.",
    outdated:
      "New versions of the terms are in force. Reload the page to display them before giving your agreement.",
    notice:
      "For your information: <doc></doc> (version {{version}}). Reading it is not an agreement.",
    offline: "An Internet connection is needed to record your agreement.",
    recorded: "Your agreement has been recorded.",
    later: "Later",
    saving: "Saving…",
    accept: "I accept",
    reload: "Reload",
  },
  authLinks: {
    label: "Help and information",
    guide: "Guide",
    contact: "Contact",
    terms: "Terms of Use",
    subscriptionTerms: "Subscription Terms",
    privacy: "Privacy",
  },
};

export default legalEn;
