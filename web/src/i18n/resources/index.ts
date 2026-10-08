import analyticsEn from "./en/analytics";
import authEn from "./en/auth";
import catalogEn from "./en/catalog";
import commonEn from "./en/common";
import legalEn from "./en/legal";
import notificationsEn from "./en/notifications";
import organizationEn from "./en/organization";
import publicEn from "./en/public";
import salesEn from "./en/sales";
import subscriptionEn from "./en/subscription";
import analyticsFr from "./fr/analytics";
import authFr from "./fr/auth";
import catalogFr from "./fr/catalog";
import commonFr from "./fr/common";
import legalFr from "./fr/legal";
import notificationsFr from "./fr/notifications";
import organizationFr from "./fr/organization";
import publicFr from "./fr/public";
import salesFr from "./fr/sales";
import subscriptionFr from "./fr/subscription";

// 1-16G — Ressources FR/EN centralisées par domaine (un fichier par
// namespace et par langue). Importées statiquement : présentes dans le build
// serveur et dans le bundle client (hors connexion compris).
export const resourcesFr = {
  common: commonFr,
  public: publicFr,
  auth: authFr,
  catalog: catalogFr,
  sales: salesFr,
  analytics: analyticsFr,
  organization: organizationFr,
  subscription: subscriptionFr,
  notifications: notificationsFr,
  legal: legalFr,
} as const;

export const resourcesEn = {
  common: commonEn,
  public: publicEn,
  auth: authEn,
  catalog: catalogEn,
  sales: salesEn,
  analytics: analyticsEn,
  organization: organizationEn,
  subscription: subscriptionEn,
  notifications: notificationsEn,
  legal: legalEn,
};

export const resources = {
  fr: resourcesFr,
  en: resourcesEn,
};
