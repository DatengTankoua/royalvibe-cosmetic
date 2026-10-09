import type authFr from "../fr/auth";
import type { Translation } from "../types";

const authEn: Translation<typeof authFr> = {
  loading: "Loading…",
  fields: {
    email: "Email",
    name: "Name",
    organizationName: "Business name",
  },
  password: {
    label: "Password",
    confirm: "Confirm password",
    hint: "Between {{min}} and {{max}} characters.",
    show: "Show password",
    hide: "Hide password",
    showBoth: "Show passwords",
    hideBoth: "Hide passwords",
    lengthError: "The password must be between {{min}} and {{max}} characters.",
    mismatch: "The passwords do not match.",
  },
  login: {
    subtitle: "Log in to your management space",
    chooseOrganization: "Choose the organisation to log in to",
    back: "Back",
    limitedExpired: "Your temporary access has expired. Log in again.",
    forgot: "Forgot your password?",
    submit: "Log in",
    submitting: "Logging in…",
    unverifiedTitle: "Email address not confirmed",
    unverifiedText:
      "Confirm your email address to access your account. Open the link you received by email, or request a new one.",
    noAccount: "No account yet?",
    signUp: "Sign up",
    errors: {
      generic: "Login error",
    },
    // 1-18C: access recovery after too many attempts on this account.
    challenge: {
      required:
        "Too many attempts for this account. Complete the anti-bot check below, then log in again.",
      missing: "Complete the anti-bot check first.",
    },
  },
  register: {
    closedTitle: "Sign-up disabled",
    closedText:
      "Online sign-up is temporarily unavailable. If you already have an account, log in.",
    // 1-18E: same final screen whether or not the address already has an account.
    doneTitle: "Check your inbox",
    doneText:
      "If {{email}} can be used for a new account, a confirmation email has just been sent to it: open the link it contains.",
    doneExisting:
      "Already have an account with this address? Log in, or reset your password if you forgot it.",
    doneForgot: "Reset my password",
    doneResend:
      "Nothing received after a few minutes? Request a new confirmation link:",
    disabled: "Sign-up is currently disabled.",
    title: "Create your business",
    subtitle: "This creates your business and your owner account.",
    submit: "Create my business",
    submitting: "Creating…",
    // 1-18C: anti-bot check (Cloudflare Turnstile).
    antiBot: {
      loading: "Loading the anti-bot check…",
      notConfigured:
        "The anti-bot check is not available: this action is temporarily impossible.",
      loadError:
        "The anti-bot check could not load. Check your connection, then try again.",
      failed:
        "The anti-bot check failed or expired. Complete it again, then try again.",
      required: "Complete the anti-bot check before creating your business.",
      unavailable:
        "The anti-bot check is temporarily unavailable. Try again in a moment.",
      retry: "Restart the check",
      simulated: "I am not a robot (local simulation)",
    },
    haveAccount: "Already have an account?",
  },
  verify: {
    metaTitle: "Confirm my email address",
    confirmToAccess: "Confirm your email address to access your account.",
    linkSent: "A confirmation link has been sent to {{email}}.",
    missingToken:
      "Incomplete confirmation link. Open the link you received by email again, in full.",
    invalid:
      "This confirmation link is invalid or has expired. Log in to request a new link.",
    network:
      "The server cannot be reached. Check your connection, then try again.",
    failed: "The confirmation could not be completed. Try again later.",
    title: "Email address confirmation",
    text: "Press the button to confirm your email address.",
    submitting: "Confirming…",
    successTitle: "Email address confirmed",
    successText: "You can now log in.",
  },
  resend: {
    neutral:
      "If an unverified account matches this address, a new confirmation link has just been sent.",
    sending: "Sending…",
    cooldown: "Resend the email ({{seconds}} s)",
    button: "Resend the confirmation email",
    errors: {
      network: "The server cannot be reached. Check your connection.",
      rateLimited: "Too many requests. Try again later.",
      deliveryUnavailable:
        "Sending emails is temporarily unavailable. Try again later.",
      generic: "The request could not be completed. Try again later.",
      // 1-18D: anti-bot check before each link request.
      antiBotRequired: "Complete the anti-bot check first.",
      antiBotFailed:
        "The anti-bot check failed or expired. Complete it again, then try again.",
      antiBotUnavailable:
        "The anti-bot check is temporarily unavailable. Try again in a moment.",
    },
  },
  forgot: {
    title: "Forgot your password",
    text: "Enter your email address: we will send you a link to choose a new password.",
    neutral:
      "If an account matches this address, you will receive a link to reset your password.",
    emailRequired: "Enter your email address.",
    cooldown: "Send the link ({{seconds}} s)",
    submit: "Send the link",
    backToLogin: "Back to login",
    errors: {
      network:
        "The server cannot be reached. Check your connection, then try again.",
      generic: "Check the email address you entered, then try again.",
    },
  },
  reset: {
    title: "New password",
    text: "Choose your new password.",
    missingToken:
      "Incomplete reset link. Open the link you received by email again, in full.",
    invalid: "This reset link is invalid or has expired. Request a new link.",
    network:
      "The server cannot be reached. Try again. If the change may have been saved, logging in with your new password lets you check.",
    submit: "Save the password",
    submitting: "Saving…",
    success: "Your password has been changed. Log in with your new password.",
    newLink: "Request a new link",
  },
  invitation: {
    missingToken:
      "Incomplete invitation link. Open the link you received again, in full.",
    checking: "Checking the invitation…",
    // 1-18B: session of the invited account or link sent to the invited address.
    chooseTitle: "Invitation to join a shop",
    chooseText:
      "To accept, log in with the account of the invited address. If you do not have an account yet, get a link at that address to create one.",
    loginToAccept: "Log in to accept",
    noAccount: "I don't have an account",
    sendingLink: "Sending…",
    cancel: "Cancel",
    linkSentTitle: "Check your inbox",
    linkSent:
      "If the invited address does not have an account yet, a link to create one has just been sent to it. It is valid for 24 hours at most.",
    linkSentExisting:
      "If you already have an account with this address, log in to accept the invitation.",
    linkErrors: {
      rateLimited: "Too many requests. Try again later.",
      deliveryUnavailable:
        "Email delivery is temporarily unavailable. Try again later.",
      network: "Unable to connect. Check your connection and try again.",
      generic: "The request could not be sent. Try again later.",
    },
    confirmTitle: "Join {{organization}}",
    confirmRole: "Proposed role: {{role}}",
    roles: {
      admin: "Administrator",
      seller: "Seller",
    },
    signedInAs: "Logged in as {{email}}",
    accept: "Accept the invitation",
    accepting: "Accepting…",
    decline: "Not now",
    acceptError: "The invitation could not be accepted. Try again.",
    mismatchTitle: "This is not the right account",
    mismatchText:
      "This invitation is for a different address than your current account. Log in with the account of the invited address.",
    switchAccount: "Switch account",
    sessionExpired:
      "Your session has expired. Log in again to accept the invitation.",
    alreadyMember: "Your account already belongs to this shop.",
    openApp: "Open the app",
    acceptedTitle: "Invitation accepted",
    joined: "You have joined {{organization}}.",
    joinedSwitch: "To access it, log in again and choose this shop.",
    reconnect: "Log in again",
    cancelledTitle: "Invitation not accepted",
    cancelledText:
      "Nothing has changed. You can open the invitation link again while it is valid.",
    backHome: "Back to home",
    noOrganizationNotice:
      "Your account does not belong to any active shop yet. Accept the invitation to join this shop; you will then be logged in.",
    accountLabel: "Account: {{email}}",
    loginNotice:
      "Log in with the account of the invited address to accept the invitation.",
    create: {
      title: "Create your account",
      text: "Choose your name and password to join the shop that invited you.",
      submit: "Create my account and join",
      submitting: "Creating…",
      successTitle: "Account created",
      success: "You have joined {{organization}}. Log in to continue.",
      invalid:
        "This account creation link is invalid or has expired. Open the invitation link again and request a new link.",
      exists:
        "An account already exists for this address. Log in, then open the invitation link again.",
      missingToken:
        "Incomplete account creation link. Open the link you received by email again, in full.",
    },
  },
};

export default authEn;
