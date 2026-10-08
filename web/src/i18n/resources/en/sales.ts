import type salesFr from "../fr/sales";
import type { Translation } from "../types";

const salesEn: Translation<typeof salesFr> = {
  loading: "Loading…",
  seller: "Seller:",
  buyer: "Buyer:",
  syncNow: "Sync now",
  pendingOnDevice: "Pending sales on this device",
  pendingOnDeviceCount: "Pending sales on this device ({{count}})",
  actions: {
    cancel: "Cancel",
    back: "Back",
    delete: "Delete",
    save: "Save",
    retry: "Try again",
  },
  nav: {
    pendingCount_one: "{{count}} pending sale",
    pendingCount_other: "{{count}} pending sales",
    pendingShort: "pending",
    pendingBadge: "Pending sales:",
  },
  list: {
    allTitle: "All sales",
    ownTitle: "My sales",
    recordOnly:
      "You can record sales from a product page. You do not have permission to view the list of sales.",
    noPermission: "You do not have permission to view sales.",
    empty: "No sales recorded.",
    nameNotKept: "(name not kept)",
    productDeleted: "Product deleted",
    nameNotRecorded: "name not recorded at the time of sale",
    renamedTo: "Now: {{name}}",
  },
  pendingPage: {
    back: "Sales",
    title: "Pending sales",
    text: "Sales recorded on this device and not yet confirmed by the server. None is deleted without your agreement.",
  },
  form: {
    title: "Sale",
    titleFix: "Correct the sale",
    offline:
      "The sale will be saved on this device and sent when the connection comes back.",
    quantity: "Quantity",
    stock: "Stock: {{count}}",
    indicativeStock: "Indicative stock: {{count}}",
    actualPrice: "Actual sale price (FCFA)",
    total: "Total: {{amount}}",
    buyerName: "Buyer name (optional)",
    buyerNamePlaceholder: "First name / Last name",
    buyerContact: "Buyer contact (optional)",
    buyerContactPlaceholder: "Phone or email",
    indicativeNote:
      "Sales of this product are waiting to be sent: the stock shown is indicative.",
    seePending: "See pending sales",
    sending: "Sending…",
    saving: "Saving…",
    saveFix: "Save the correction",
    confirm: "Confirm the sale",
    record: "Record a sale",
    recorded: "Sale recorded",
    conflictHint: "See “Pending sales” to correct it.",
    pending: "Sale saved on this device, waiting to be synchronised",
    pendingHint:
      "It will be sent automatically when the connection comes back.",
    errors: {
      quantity: "The quantity must be a whole number of 1 or more.",
      aboveIndicative: "Quantity above the indicative stock ({{max}}).",
      aboveStock: "Quantity above the available stock ({{max}}).",
      price: "The price must be a positive number or zero.",
      buyerLength: "Name and contact: {{max}} characters maximum.",
    },
    refusal: {
      capability: "Recording sales is not allowed on this device.",
      identity: "Session not verified on this device: log in again.",
      invalid: "Invalid sale details.",
      limit:
        "Limit of 200 pending sales reached: synchronise them before entering more.",
      unavailable: "Local storage unavailable: sale not saved.",
      "not-replaceable": "This sale can no longer be corrected.",
    },
  },
  edit: {
    title: "Edit the sale",
    price: "Sale price (FCFA)",
    updated: "Sale updated",
    deleted: "Sale deleted",
    deleteTitle: "Delete this sale?",
    deleteText:
      "The stock will be restored automatically. This action cannot be undone.",
    deleting: "Deleting…",
  },
  logout: {
    title: "Sales not synchronised",
    description_one:
      "{{count}} sale saved on this device has not yet been confirmed by the server.",
    description_other:
      "{{count}} sales saved on this device have not yet been confirmed by the server.",
    descriptionOrganizations_one:
      "{{count}} sale saved on this device ({{organizations}} organisations) has not yet been confirmed by the server.",
    descriptionOrganizations_other:
      "{{count}} sales saved on this device ({{organizations}} organisations) have not yet been confirmed by the server.",
    syncing: "Synchronising… (10 s max)",
    keep: "Log out and keep them on this device",
    delete: "Delete permanently…",
    deleteWarning:
      "These sales will be erased from this device and will NEVER be sent to the server. This cannot be undone.",
    deleteFailed:
      "Deletion failed: nothing was erased. Try again or keep the sales.",
    deleteConfirm: "Delete permanently and log out",
  },
  outbox: {
    loading: "Loading local sales…",
    unreadable:
      "Local sales cannot be read for this session. Log in again to access them; they are still kept on this device.",
    counts: {
      pending: "Pending",
      syncing: "Sending",
      conflict: "To resolve",
    },
    status: {
      pending: "Pending",
      syncing: "Sending",
      synced: "Synchronised",
      conflict: "To resolve",
      abandoned: "Abandoned",
    },
    blocked: {
      subscription:
        "Sending paused: this shop's subscription is not active. The sales stay on this device and will be sent after the renewal.",
      accessDenied:
        "Sending paused: the server refused access (session, rights or organisation). Log in again or contact an administrator; the sales stay on this device.",
      corruption:
        "Sending paused: an inconsistency was detected. Note the sales concerned and contact support before removing the operation.",
    },
    resumeOnline:
      "Sending will resume automatically when the connection comes back, with the app open.",
    empty: "No pending sales on this device.",
    listLabel: "Unfinished sales",
    actionFailed: "Action not possible.",
    recentlySynced: "Recently synchronised ({{count}})",
    syncedRetention: "Erased automatically from this device after 7 days.",
    cancelledLater: "Cancelled afterwards",
    confirmed: "Confirmed",
    attempts_one: "Attempts: {{count}}.",
    attempts_other: "Attempts: {{count}}.",
    confirm: {
      removeTitle: "Remove this sale from the queue?",
      abandonTitle: "Abandon this sale?",
      mayBeRecorded:
        "Warning: the server may already have recorded this sale. Check the list of sales before abandoning it.",
      neverSent: "This sale will never be sent to the server.",
      staysVisible:
        "It will no longer be offered for sending and will stay visible on this device (no silent deletion).",
    },
    actions: {
      edit: "Correct",
      retry: "Try again",
      abandon: "Abandon",
      remove: "Remove",
      removeFromQueue: "Remove from the queue",
    },
    errors: {
      insufficientStock: "Not enough stock on the server.",
      productNotFound: "Product not found or deleted.",
      dateOutOfRange: "Sale date outside the allowed period.",
      validationFailed: "Sale details refused by the server.",
      expired: "Sale pending for more than 14 days: not sent automatically.",
      serverUnavailable: "Server unavailable after several attempts.",
      alreadyApplied: "Already recorded by the server, then cancelled.",
      inconsistency:
        "Inconsistency detected: note this sale and contact support.",
      accessDenied: "Access refused by the server.",
      subscriptionInactive:
        "Shop subscription inactive: sale kept, will be sent after renewal.",
      network: "Network unavailable, automatic retry.",
      server: "Sending temporarily impossible, automatic retry.",
      auth: "Session expired or access refused.",
      refused: "Sale refused by the server.",
    },
  },
};

export default salesEn;
