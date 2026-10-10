import type organizationFr from "../fr/organization";
import type { Translation } from "../types";

const organizationEn: Translation<typeof organizationFr> = {
  title: "Organisation",
  loading: "Loading…",
  saving: "Saving…",
  creating: "Creating…",
  deleting: "Deleting…",
  actions: {
    save: "Save",
    cancel: "Cancel",
    close: "Close",
  },
  tabs: {
    branding: "Branding",
    members: "Members",
    invitations: "Invitations",
    subscription: "Subscription",
    offline: "Offline",
    notifications: "Notifications",
    support: "Support",
    storage: "Storage",
  },
  roles: {
    owner: "Owner",
    admin: "Administrator",
    seller: "Seller",
  },
  permissions: {
    "catalog.manage": "Manage the catalogue",
    "products.manage": "Manage products",
    "stock.adjust": "Adjust stock",
    "sales.record": "Record sales",
    "sales.view_own": "See own sales",
    "sales.view_all": "See all sales",
    "products.view_stock_details": "See stock details",
    "products.view_financials": "See costs and financial results",
    "analytics.read": "View analytics",
    "audit.read": "See the audit history",
    "trash.manage": "Manage trash",
    "branding.manage": "Manage branding",
    "members.invite": "Invite members",
    "members.manage": "Manage members",
    "support.contact": "Contact customer support",
    "sales.notifications": "Receive sale notifications",
  },
  memberStatus: {
    active: "Active",
    suspended: "Suspended",
    revoked: "Revoked",
  },
  invitationStatus: {
    pending: "Pending",
    accepted: "Accepted",
    revoked: "Revoked",
    expired: "Expired",
  },
  permissionsField: {
    label: "Additional permissions",
    none: "No additional permissions available.",
    adminAll: "An administrator has all permissions.",
  },
  errors: {
    SELF_MANAGEMENT_FORBIDDEN: "A member cannot change their own membership.",
    OWNER_NOT_MANAGEABLE: "The owner cannot be changed from this screen.",
    EMPTY_MEMBERSHIP_UPDATE: "At least one field must be changed.",
    TRANSFER_TARGET_IS_CURRENT_OWNER:
      "This person is already the owner of the organisation.",
    TRANSFER_TARGET_NOT_ACTIVE:
      "The transfer target must have an active membership.",
    MEMBER_ALREADY_ACTIVE:
      "This email already belongs to an active member of this organisation.",
    INVITATION_ALREADY_PENDING:
      "An invitation is already pending for this email.",
    INVITATION_LINK_UNAVAILABLE:
      "The invitation link cannot be generated at the moment. Contact the application administrator.",
    EMPTY_BRANDING_UPDATE:
      "At least one field (name, colour, logo) is required.",
    PERMISSION_DENIED: "Insufficient permission for this action.",
  },
  branding: {
    updated: "Branding updated",
    logoRemoved: "Logo removed",
    oldLogoNotDeleted:
      "The previous logo file could not be erased from storage; it remains there for now.",
    logoAlt: "Organisation logo",
    noLogo: "No logo",
    colorLabel: "Colour {{color}}",
    removeLogo: "Remove the logo",
    name: "Organisation name",
    color: "Brand colour",
    logo: "Logo (optional)",
    logoTooLarge: "The logo must not exceed 2 MB.",
    logoHelp: "PNG, non-animated WebP or JPEG, 2 MB maximum.",
    readOnly: "View the organisation's branding and brand colour.",
  },
  members: {
    transferred: "Ownership transferred",
    permissionRequired:
      "The “{{permission}}” permission is required to access this screen.",
    you: "(you)",
    edit: "Edit",
    editTitle: "Edit {{name}}",
    transfer: "Transfer ownership",
    transferTitle: "Transfer ownership?",
    transferText:
      "You are about to permanently hand over ownership of this organisation to <name></name>. You will become an administrator and will not be able to undo this action yourself.",
    transferring: "Transferring…",
    transferConfirm: "Confirm the transfer",
    updated: "Member updated",
    status: "Status",
  },
  invitations: {
    revoked: "Invitation revoked",
    empty: "No invitations yet.",
    expiresOn: "Expires on {{date}}",
    expiresAt: "Expires on {{date}}.",
    revoke: "Revoke",
    revokeTitle: "Revoke this invitation?",
    revokeText: "The invitation for <email></email> can no longer be accepted.",
    revoking: "Revoking…",
    created: "Invitation created",
    invite: "Invite a member",
    newTitle: "New invitation",
    copyHint: "Copy this link and send it to {{email}}. It is shown only once.",
    link: "Invitation link",
    copy: "Copy the link",
    copied: "Link copied",
    copyManual:
      "Automatic copy failed: the link is selected, copy it manually.",
    email: "Email",
    role: "Role",
    submit: "Create the invitation",
  },
  // 1-17B — organisation storage space (photos and logo).
  storage: {
    title: "Storage space",
    text: "Product photos (including the trash) and the organisation logo. The limit is set by Stock Master.",
    used: "{{used}} used of {{limit}}",
    available: "Available: {{available}}",
    files_one: "{{count}} stored file",
    files_other: "{{count}} stored files",
    pending_one:
      "{{count}} upload in progress or interrupted ({{size}} reserved). Reserved space is released automatically if unused.",
    pending_other:
      "{{count}} uploads in progress or interrupted ({{size}} reserved). Reserved space is released automatically if unused.",
    full: "Storage full: new photo and logo uploads are blocked. Sales and other features remain available. Empty the trash or replace photos to free up space.",
    nearlyFull: "Storage almost full.",
    trashNote:
      "Moving a product to the trash does not free up space; permanent deletion does.",
    notEnforced: "Limit not enforced for now (counting only).",
    refresh: "Refresh",
    unavailable: "Usage unavailable at the moment.",
    offline: "An internet connection is required to show usage.",
  },
  offlineData: {
    cleared: "Offline data deleted.",
    clearFailed: "The offline data could not be deleted.",
    title: "Offline data",
    text: "Stock Master keeps a read-only copy of the last catalogue loaded successfully (sections, products, stock, prices), as well as the shop's name and colour, to display them without a connection, for 72 hours at most. No sale, image, audit data or data from another organisation is ever stored there.",
    clear: "Delete offline data",
  },
  support: {
    title: "Contact customer support",
    intro:
      "Describe your question or your problem. The reply will arrive by email.",
    forbidden:
      "Your role does not allow you to contact customer support from this shop. Ask the owner or an administrator for this right, or use the details on the <contact>Contact</contact> page.",
    sentTitle: "Message sent",
    referenceLabel: "Your request reference:",
    sentText:
      "The sending service accepted your message. This does not yet confirm it has been read: the reply will arrive at {{email}}. Quote the reference if you write again.",
    yourEmail: "your email address",
    writeAnother: "Write another message",
    offline:
      "No connection: sending needs the Internet. You can keep writing; your text stays on this screen.",
    category: "Category",
    choose: "Choose…",
    categories: {
      usage: "Using the app",
      subscription: "Subscription",
      technical: "Technical problem",
      other: "Other",
    },
    subject: "Subject",
    message: "Message",
    charCount: "{{length}} / {{count}} characters",
    fieldErrors: {
      category: "Choose a category.",
      subject: "Enter a subject.",
      message: "Write your message.",
    },
    contextTitle: "Information sent to customer support",
    contextText:
      "It is attached automatically to your message to find your account and your shop. It cannot be changed here. No sale, no buyer contact, no file and no password is attached.",
    name: "Name",
    replyEmail: "Email (reply)",
    shop: "Shop",
    page: "Page concerned",
    reference: "Reference:",
    sending: "Sending…",
    submit: "Send to customer support",
    errors: {
      offline:
        "No connection: sending needs the Internet. Your message is kept on this screen.",
      uncertain:
        "We do not know whether the message was sent. Try again: for 24 hours, a new attempt does not create a duplicate.",
      expired:
        "We do not know whether this message was sent, and it can no longer be resent without risking a duplicate. Write to {{email}} quoting the reference.",
      "in-progress":
        "This message is already being sent. Wait a few seconds, then try again.",
      unavailable:
        "The message could not be sent at the moment. Try again later: your text is kept.",
      "rate-limited":
        "Too many requests sent. Try again in a few minutes: your text is kept.",
      forbidden:
        "You no longer have the right to contact customer support from this shop.",
      invalid: "Check the category, the subject and the message.",
      conflict:
        "This message has changed since the first attempt. It will be sent as a new request.",
    },
  },
};

export default organizationEn;
