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
  },
  register: {
    closedTitle: "Sign-up disabled",
    closedText:
      "Online sign-up is temporarily unavailable. If you already have an account, log in.",
    doneTitle: "Account created",
    doneText: "Your business and your owner account have been created.",
    deliveryFailed:
      "The confirmation email could not be sent. Your account has been created: request a new email below.",
    disabled: "Sign-up is currently disabled.",
    title: "Create your business",
    subtitle: "This creates your business and your owner account.",
    submit: "Create my business",
    submitting: "Creating…",
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
    acceptedTitle: "Invitation accepted",
    joined: "You have joined {{organization}}.",
    joinedLogin: "You have joined {{organization}}. Log in to continue.",
    loginToContinue: "Log in to continue.",
    deliveryFailed:
      "The confirmation email could not be sent. Request a new email below.",
    finish: "Finish creating your account.",
    submit: "Create my account",
    submitting: "Confirming…",
  },
};

export default authEn;
