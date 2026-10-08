import type subscriptionFr from "../fr/subscription";
import type { Translation } from "../types";

const subscriptionEn: Translation<typeof subscriptionFr> = {
  offers: {
    term: {
      monthly: "1 month",
      quarterly: "3 months",
      semiannual: "6 months",
      annual: "12 months",
    },
    highlight: {
      saving: "{{amount}} saved",
      freeMonths: "2 months free",
    },
    best: "Best value",
    forTerm: "for {{term}}",
    monthlyEquivalent: "that is {{amount}} / month as a monthly equivalent",
    saving: "{{amount}} saved compared with paying monthly",
    monthlyPayment: "Monthly payment",
    included: {
      catalog: "Catalogue, stock and sales",
      converter: "EUR ↔ FCFA converter",
      analytics: "Analytics and trash",
      members: "Members and permissions",
    },
    ctaLabel: "{{label}} — {{term}} plan",
    selectorLabel: "Renewal length",
    conditions: {
      features:
        "Same features for every length, according to each member's rights.",
      perShop: "One subscription per shop, no extra charge per seller.",
      noAutoPay: "No automatic payment: every renewal is voluntary.",
    },
  },
  overview: {
    dateAt: "{{date}} at {{time}}",
    state: {
      trial: "Free trial in progress",
      active: "Subscription active",
      expired: "Subscription expired",
      scheduled: "Upcoming period",
      none: "No subscription",
    },
    trial: "Free trial",
    subscriptionTerm: "{{term}} subscription",
    lessThanDay: "less than a day",
    days_one: "{{count}} day",
    days_other: "{{count}} days",
    status: "Status",
    currentPeriod: "Current period",
    fromTo: "from {{from}} to {{to}}",
    accessEnded: "Access ended on",
    accessUntil: "Access covered until",
    remaining: "Time left: {{remaining}}",
    nextPeriod: "Next period",
    startingOn: "starting {{date}}",
    historyTitle: "Period history",
    historyEmpty: "No periods.",
    historyNote:
      "History of access periods, without amounts: payments are listed in the payment history; invoices will be available later.",
  },
  manager: {
    checkUnavailable: "Check temporarily unavailable.",
    infoUnavailable: "Subscription information unavailable.",
    loading: "Loading subscription…",
    verify: "Check my subscription",
    renewal: "Renewal",
    paymentUnavailable:
      "Payment temporarily unavailable. Use “Check my subscription”.",
  },
  page: {
    title: "Subscription",
    loading: "Loading…",
    ownerOnly: "Only the shop owner can manage the subscription.",
    verified: "Subscription checked.",
  },
  block: {
    title: {
      expired: "This shop's subscription has expired",
      none: "This shop has no active subscription",
      scheduled: "This shop's subscription has not started yet",
      active: "This shop's subscription is active",
      inactive: "This shop's subscription is not active",
    },
    text: {
      offline:
        "You are offline. The check will resume when the connection comes back.",
      activeLimited: "Use “Check my subscription” to get access back.",
      owner: "Renew the subscription to get access to your shop back.",
      member: "Contact the owner to renew.",
    },
    verifyAccess: "Check access",
    logout: "Log out",
  },
  verify: {
    stillInactive: "The subscription is still not active.",
    stale: "The session has changed: reload the page.",
    offline: "Checking is not possible offline.",
  },
  access: {
    yourShop: "Your shop",
    retry: "Try again",
  },
  localSales: {
    unreadable:
      "Local sales cannot be read for this session: they are still kept on this device.",
    title_one: "Pending sale on this device ({{count}})",
    title_other: "Pending sales on this device ({{count}})",
    text: "They are kept and will be sent after the renewal.",
  },
  payment: {
    status: {
      initiating: {
        label: "Request in progress",
        lower: "request in progress",
        detail: "The payment request is being sent to the operator.",
      },
      pending: {
        label: "Waiting for payment",
        lower: "waiting for payment",
        detail:
          "Approve the payment on the payer's phone, then tap “Check payment”.",
      },
      uncertain: {
        label: "Result to check",
        lower: "result to check",
        detail:
          "Sending could not be confirmed. Check this payment: no new request will be sent.",
      },
      review: {
        label: "Review needed",
        lower: "review needed",
        detail:
          "This payment must be reviewed by our team. No new request is possible in the meantime.",
      },
      failed: {
        label: "Failure confirmed",
        lower: "failure confirmed",
        detail: "The operator confirmed that this payment did not go through.",
      },
      succeeded: {
        label: "Payment confirmed",
        lower: "payment confirmed",
        detail:
          "The payment is confirmed and the subscription has been extended.",
      },
    },
    errors: {
      "no-response":
        "No response received. Nothing is lost: check your connection, then try again.",
      unexpected:
        "No response received. Nothing is lost: check your connection, then try again.",
      unauthorized: "Your session has expired. Log in again.",
      unauthorizedRestricted:
        "Your session has expired. Log in again: your payment will be found.",
      forbidden: "Access denied for this shop.",
      "already-pending": "A payment is already in progress for this shop.",
      "operation-conflict":
        "This request was already sent with different details. Enter exactly the same number.",
      "invalid-phone":
        "Invalid Cameroonian Mobile Money number (e.g. 6XX XX XX XX).",
      "invalid-request": "Invalid request. Check the details you entered.",
      "not-found": "Payment not found for this shop.",
      "rate-limited": "Too many requests. Wait before trying again.",
      "service-unavailable":
        "Online payment is unavailable at the moment. Try again later.",
      "status-unavailable":
        "This payment cannot be checked at the moment. Try again later.",
      "confirmation-pending":
        "Payment being confirmed. Check again in a moment.",
    },
    messages: {
      offlineCreate: "Offline: creating a payment needs the Internet.",
      termRequired: "Choose a length.",
      phoneRequired: "Enter the payer's Mobile Money number.",
      replayed: "Request found: no new payment was requested.",
      sent: "Request sent. The subscription will be active once the payment is confirmed.",
      confirmed: "Payment confirmed. Restoring access…",
      offlineVerify: "Offline: checking needs the Internet.",
      statusChecked: "Status checked: {{status}}.",
      statusNow: "This payment is now: {{status}}.",
    },
    loading: "Loading payments…",
    offline: "Offline: creating and checking a payment need the Internet.",
    term: "Length",
    totalAmount: "Total amount",
    payer: "Payer",
    reference: "Reference",
    requestedOn: "Requested on",
    confirmedOn: "Confirmed on",
    pinNotice:
      "The Mobile Money PIN is entered only on the payer's phone. Stock Master never asks for it.",
    checking: "Checking…",
    verify: "Check payment",
    openShop: "Go to my shop",
    newAttempt: "Try again",
    renew: "Renew",
    formTitle: "Pay with Mobile Money",
    lockedIntent:
      "A previous request did not get a response. Enter <b>the same number</b> again to find it: no second payment will be requested. Length: <b>{{term}}</b>.",
    phoneLabel: "Payer's Mobile Money number",
    phoneHelp:
      "MTN Mobile Money or Orange Money (Cameroon). The payer will approve on their phone; no PIN is asked for here.",
    summary:
      "Total amount: <b>{{amount}}</b> for <b>{{term}}</b>. The subscription will be extended once the payment is confirmed.",
    summaryEmpty: "Select a length to see the total amount.",
    sending: "Sending…",
    payAmount: "Pay {{amount}}",
    pay: "Pay",
    cancel: "Cancel",
    historyTitle: "Payment history",
    historyUnavailable: "Payment history unavailable.",
    historyMore: "More payments could not be loaded.",
    historyEmpty: "No payments.",
    loadingMore: "Loading…",
    showMore: "Show more",
  },
};

export default subscriptionEn;
