import type notificationsFr from "../fr/notifications";
import type { Translation } from "../types";

const notificationsEn: Translation<typeof notificationsFr> = {
  title: "Notifications",
  loading: "Loading…",
  empty: "No notifications.",
  unreadMark: "(unread)",
  showMore: "Show more",
  noneForRole: "No notifications are offered for your role.",
  categories: {
    stockDepleted: {
      label: "Out of stock",
      help: "When a product's stock reaches zero.",
    },
    stockLow: {
      label: "Running low",
      help: "When 80% of a product's initial stock has been used.",
    },
    saleCreated: {
      label: "New sale",
      help: "For every recorded sale (push grouped by minute).",
    },
    subscriptionEnding: {
      label: "End of trial or subscription",
      help: "A reminder within the 24 hours before the end date.",
    },
    paymentSucceeded: {
      label: "Payment confirmed",
      help: "When a subscription payment is confirmed.",
    },
    monthlyReport: {
      label: "Monthly summary",
      help: "At the start of each month, the summary of the past month.",
    },
    memberJoined: {
      label: "New member",
      help: "When an invited person joins the business.",
    },
    memberActivity: {
      label: "Team activity",
      help: "Items created, changed or deleted by other members (grouped by minute).",
    },
  },
  bell: {
    noneUnread: "Notifications, none unread",
    moreThan99: "Notifications, more than 99 unread",
    unread_one: "Notifications, {{count}} unread",
    unread_other: "Notifications, {{count}} unread",
    recent: "Recent notifications",
    seeAll: "See all notifications",
  },
  list: {
    readAll: "Mark all as read",
    filter: "Filter",
    all: "All",
    unread: "Unread",
    unavailable: "Notifications unavailable at the moment.",
    emptyUnread: "No unread notifications.",
  },
  detail: {
    missing: "Notification not found or no longer available.",
    open: "Open",
    productRemoved: "This product has been permanently deleted.",
    product: "Product",
    inTrash: "(trash)",
    remainingStock: "Remaining stock",
    saleCancelled: "This sale has since been cancelled.",
    quantity: "Quantity",
    amount: "Amount",
    seller: "Seller",
    date: "Date",
    trialEnd: "End of the trial: {{date}}",
    subscriptionEnd: "End of the subscription: {{date}}",
    paymentConfirmed: "Payment confirmed.",
    paymentConfirmedOn: "Payment confirmed on {{date}}.",
    reportUnavailable: "Summary unavailable.",
    amountHidden:
      "Amount and quantity are only visible with the “View all sales” permission.",
    member: "Member",
    role: "Role",
    memberInactive: "This member is no longer part of the business.",
    roles: {
      owner: "Owner",
      admin: "Administrator",
      seller: "Seller",
    },
    author: "By",
    unknownAuthor: "A team member",
    actionsCount_one: "{{count}} action",
    actionsCount_other: "{{count}} actions",
    targets: "Affected items",
    unnamed: "Unnamed item",
    removed: "(deleted)",
    moreTargets_one: "and {{count}} more",
    moreTargets_other: "and {{count}} more",
  },
  report: {
    summary_one:
      "Summary for {{month}} (from {{from}} to {{to}}, {{timeZone}} time zone) — calculated on {{computedAt}}. {{count}} sale.",
    summary_other:
      "Summary for {{month}} (from {{from}} to {{to}}, {{timeZone}} time zone) — calculated on {{computedAt}}. {{count}} sales.",
    topProducts: "Best-selling products",
    noSales: "No sales this month.",
    unknownProduct: "Unknown product",
    deleted: "(deleted)",
    unitsSold_one: "{{count}} sold",
    unitsSold_other: "{{count}} sold",
    sellerOfMonth: "Seller of the month",
    noSeller: "No seller of the month (no sales).",
    unsold: "Products without sales ({{count}})",
    allSold: "All products have been sold.",
    addedDuringMonth: "added during the month",
    purgedNote:
      "Products permanently deleted without sales during the month: not listed (no record kept).",
  },
  center: {
    title: "In the app",
    text: "Notifications shown under the bell, on all your devices, even without push notifications.",
    unavailable: "Preferences unavailable at the moment.",
    legend: "Categories shown",
  },
  push: {
    title: "Push notifications on this device",
    text: "Receive important alerts on this device, even when the app is closed. Messages are deliberately general (no amount or product name on the lock screen); tap the notification to see the details.",
    unavailable: "Notification settings unavailable at the moment.",
    enabled: "Notifications turned on for this device.",
    disabled: "Notifications turned off for this device.",
    denied: "Notifications refused by the browser.",
    enabling: "Turning on…",
    enable: "Turn on notifications",
    disable: "Turn off notifications",
    legend: "Notify me about",
    notices: {
      disabled: "Notifications are not available on this service.",
      unsupported: "This browser does not support push notifications.",
      iosInstall:
        "On iPhone and iPad, notifications are only offered to the app added to the home screen.",
      blocked:
        "Notifications are blocked for this site. Allow them in the browser settings, then come back here.",
    },
    iosTitle: "iPhone and iPad",
    iosHelp:
      "Open Stock Master in Safari, tap Share then “Add to Home Screen”. Then launch the app from its icon and come back to this page to turn on notifications (iOS / iPadOS 16.4 or later).",
  },
  engagement: {
    later: "Later",
    install: {
      title: "Install Stock Master",
      body: "Open the app from your home screen, like any other app.",
      action: "Install",
    },
    ios: {
      title: "Add Stock Master to your home screen",
      body: "On iPhone and iPad, the installed app can also receive notifications.",
      help: "In Safari, tap Share then “Add to Home Screen”.",
    },
    push: {
      title: "Turn on notifications",
      body: "Be alerted about stock-outs, sales and due dates, even when the app is closed.",
      action: "Turn on",
    },
    denied: {
      title: "Notifications blocked",
      body: "Notifications are refused for this site on this device.",
      help: "Allow them in the browser settings (site settings), then reload the page.",
    },
  },
};

export default notificationsEn;
