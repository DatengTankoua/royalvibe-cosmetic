import type commonFr from "../fr/common";
import type { Translation } from "../types";

const commonEn: Translation<typeof commonFr> = {
  meta: {
    appDescription: "Stock and sales management app",
  },
  language: {
    title: "Language",
    trigger: "Language: {{language}}",
  },
  theme: {
    title: "Display theme",
    trigger: "Display theme: {{theme}}",
    light: "Light",
    dark: "Dark",
    system: "Automatic",
  },
  backToHome: "Back to home page",
  notFound: {
    code: "Error 404",
    title: "This page cannot be found",
    text: "The link may be incomplete, or the page may have moved.",
  },
  offline: {
    title: "You are offline",
    text: "Business data (catalogue, sales, analytics) and any change need an Internet connection. Reconnect, then try again.",
  },
  actions: {
    retry: "Try again",
    cancel: "Cancel",
    close: "Close",
    save: "Save",
    delete: "Delete",
    back: "Back",
  },
  fields: {
    maxLength_one: "{{count}} character maximum.",
    maxLength_other: "{{count}} characters maximum.",
  },
  errors: {
    network: "The server cannot be reached. Check your connection.",
    subscriptionInactive: "This shop's subscription is not active.",
    statusUnavailable: "Check temporarily unavailable. Try again.",
    forbidden: "Access denied.",
    notFound: "Not found.",
    server: "Server error. Try again in a few moments.",
    status: "Error {{status}}.",
    unexpected: "An unexpected error occurred.",
    uploadInterrupted: "The file upload was interrupted. Try again.",
  },
  converter: {
    title: "EUR ↔ CFA franc converter",
    euro: "Euro (€)",
    cfa: "CFA franc (FCFA)",
    rate: "Official fixed rate: 1 EUR = {{rate}} FCFA",
    parity: "(Fixed FCFA parity, WAEMU zone / Banque de France)",
  },
  shell: {
    nav: {
      home: "Home",
      catalog: "Catalogue",
      sales: "Sales",
      analytics: "Analytics",
      trash: "Trash",
      organization: "Organisation",
      help: "Help",
    },
    myShop: "My shop",
    myAccount: "My account",
    loading: "Loading…",
    offline: "Offline",
    offlineUnavailable: "Unavailable offline",
    otherPagesOffline: "Other pages: unavailable offline",
    offlineMessage:
      "You are offline. You can view the data saved on this device and enter sales, which will be sent when the connection comes back.",
    organizationUnavailable: "Current organisation unavailable.",
    converter: "EUR ↔ CFA converter",
    more: "More",
    quit: "Quit",
    accessRefused:
      "Your access to this organisation is no longer active. Contact an administrator or log out.",
    noOrganization:
      "No active organisation. Contact an administrator or log out.",
    logout: {
      button: "Log out",
      unverified:
        "Local sales not verified: they are still kept on this device.",
      synced: "Sales synchronised.",
      stillPending:
        "Some sales are still pending (other organisation, conflict or network).",
    },
  },
};

export default commonEn;
