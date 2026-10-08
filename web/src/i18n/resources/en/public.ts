import type publicFr from "../fr/public";
import type { Translation } from "../types";

const publicEn: Translation<typeof publicFr> = {
  skipToContent: "Skip to content",
  nav: {
    features: "Features",
    offline: "No network",
    pricing: "Pricing",
    faq: "Questions",
  },
  header: {
    homeTop: "Stock Master, back to top",
    backHome: "Stock Master, back to home page",
    sections: "Page sections",
    sectionsMenu: "Page sections (menu)",
    openMenu: "Open menu",
    closeMenu: "Close menu",
    help: "Help",
    guide: "Guide",
    contact: "Contact",
  },
  footer: {
    tagline: "Stock, sales and team for shops, from your phone.",
    help: "Help and account",
    legal: "Legal information",
    login: "Log in",
    register: "Sign up",
    pages: {
      guide: "User guide",
      contact: "Contact",
    },
  },
  cta: {
    loading: "Loading…",
    openApp: "Open the app",
    login: "Log in",
    register: "Create an account",
  },
  preview: {
    analyticsAlt:
      "Screenshot of the Stock Master Analytics screen for the sample shop Demo Shop, current month: sales amount 137,500 FCFA (+13.8% versus the same period last month), 58 sales for 84 units, estimated gain 28,050 FCFA, then the sales-per-day chart.",
    salesAlt:
      "Screenshot of the Stock Master Sales screen for the sample shop Demo Shop: latest recorded sales, with product, seller, date, quantity and amount in FCFA.",
    caption:
      "Real screenshots of the app, English interface · Demo Shop, sample products and sales.",
  },
  landing: {
    meta: {
      title: "Stock Master — Your shop's stock and sales, on your phone",
      description:
        "Real-time sales and stock, restocking guidance and monthly Excel/PDF history. In French and English.",
      price: "{{monthly}} per month, or {{best}} for {{term}}",
      trial: "{{days}}-day free trial, then {{price}}.",
      subscription: "Subscription: {{price}}.",
      ogDescription:
        "Stock, sales, team and analytics for shops and small businesses.",
      ogTrial: "{{days}}-day free trial.",
    },
    hero: {
      title: "Track your stock and sales from your phone",
      text: "Sold two soaps? Stock goes down and connected teammates see the update. Stock Master brings catalogue, sales and clear indicators together to help you run your shop.",
      trialNote:
        "{{days}}-day free trial, no payment required. Then from <price>{{price}} per month</price> with the {{term}} plan.",
      registrationClosed:
        "Sign-ups are temporarily closed. Shops that already have an account can log in.",
      alreadyRegistered: "Already registered? <login>Log in</login>",
    },
    cta: {
      startTrial: "Start my free trial",
      login: "Log in",
      seePricing: "See pricing",
    },
    benefits: {
      title: "Everything you need to run the shop",
      stock: {
        title: "Track your stock",
        text: "Organise rice, oil and soap by section. Each sale updates stock, and low or out-of-stock products are flagged based on your rights.",
      },
      sales: {
        title: "Record your sales",
        text: "Choose the product, quantity and actual price, then confirm. Every sale keeps its date and the seller's name. Connected teammates see updates without reloading.",
      },
      team: {
        title: "Work with your team",
        text: "Invite your sellers with a link and choose what each person can do: sell, manage the catalogue, see the figures. The price does not change with the number of sellers.",
      },
      analytics: {
        title: "Understand your business",
        text: "Analytics highlights products to watch, best sellers and estimated gain according to your rights. Example: spot oil to restock from the pace of recorded sales. It helps decisions; it is not automatic ordering or guaranteed profit.",
      },
      history: {
        title: "Keep each month's history",
        text: "Owner and administrator can choose a month in Analytics and download Excel or PDF. You get the summary, sales, products, sellers and corrections, excluding sales still pending on a device.",
      },
      notifications: {
        title: "See alerts and get support",
        text: "The bell shows notifications that match your rights. Need help with a sale? The owner, administrator or an authorised seller can write from Organisation → Support.",
      },
      alsoIncluded:
        "Make it yours: French or English, light or dark mode, logo and shop colours. Also included: trash and the euro ↔ CFA franc converter.",
    },
    offline: {
      title: "Network down? You keep selling.",
      steps: {
        open: {
          title: "Open the app while you have network",
          text: "On the same device, account and shop, load the catalogue with a session allowed to sell. The catalogue and this capability are kept for up to 72 hours; the session must remain valid.",
        },
        sell: {
          title: "Sell even without a connection",
          text: "A soap sale stays on this device, marked “pending”. Offline stock is indicative: it does not include teammates' sales.",
        },
        sync: {
          title: "The network comes back, the sales are sent",
          text: "With the app open and a valid session, sending resumes automatically. The server checks stock and rights again; if a sale is refused, use Pending sales.",
        },
      },
      note: "Without network: only already-loaded catalogue and new sale entry. Products, analytics, exports and team management need a connection. The queue is limited to 200 non-finalised sales per account and shop on this device; after 14 days, a sale is no longer sent automatically. Keep the same device for recovery.",
    },
    pricing: {
      title: "One subscription, the length you choose",
      text: "One price for the whole shop. The amount shown covers the chosen length. Online payment is not available yet: to renew, the owner contacts support.",
      trial: "{{days}}-day free trial, no bank card",
      equivalent:
        "That is {{monthly}} per month and {{saving}} saved compared with paying monthly.",
      equivalentFree:
        "That is {{monthly}} per month and {{saving}} saved compared with paying monthly, or {{highlight}}.",
      monthByMonth: "Pay month by month.",
      closed: "Sign-ups are temporarily closed. <login>Log in</login>",
    },
    faq: {
      title: "Frequently asked questions",
      startOpen: {
        question: "How do I get started?",
        answer:
          "Create your account with your shop's name, then confirm your email address with the link you receive. Log in, add your sections and products: you can record your first sales. The {{days}}-day free trial starts when the shop is created.",
      },
      startClosed: {
        question: "How do I get started?",
        answer:
          "Online sign-ups are temporarily closed. If your shop already has an account, log in. A seller joins the shop with the invitation link sent by the owner.",
      },
      sellers: {
        question: "Can my sellers use the app?",
        answer:
          "Yes. In the Organisation area, create an invitation: you get a link to send to the seller, for example by text message or a messaging app. They create their access with this link. Every member can record sales; you add the other rights one by one.",
      },
      install: {
        question: "Do I need to install an app on my phone?",
        answer:
          "No. Stock Master opens in the browser of a phone, tablet or computer, without going through an app store. You can install the app from the browser for quicker access. Once installed, you can open it straight from your home screen.",
      },
      network: {
        question: "What if the connection is poor?",
        answer:
          "If you opened the app with network in the last 72 hours, you can keep recording sales without a connection. They stay on the device for up to 14 days and are sent as soon as the network comes back. Adding products, viewing analytics or managing the team needs a connection.",
      },
      subscription: {
        question: "How does the subscription work?",
        answer:
          "The owner chooses a length of 1, 3, 6 or 12 months in the Subscription area. Online payment is not available yet; to renew, the owner contacts support. There is no automatic payment: every renewal is voluntary. The price covers the whole shop, whatever the number of sellers.",
        answerTrial:
          "After the {{days}}-day trial, the owner chooses a length of 1, 3, 6 or 12 months in the Subscription area. Online payment is not available yet; to renew, the owner contacts support. There is no automatic payment: every renewal is voluntary. The price covers the whole shop, whatever the number of sellers.",
      },
      privacy: {
        question: "Can other shops see my data?",
        answer:
          "No. Each shop has its own space. Only the members you invite can access it, with the rights you give them.",
      },
    },
    final: {
      titleOpen: "Try Stock Master in your shop",
      titleClosed: "Find your shop in Stock Master",
      textOpen:
        "Create your account, add a few products and record your first sales. You have {{days}} free days to make up your mind.",
      textClosed:
        "Log in to find your catalogue, your sales and your analytics.",
    },
  },
};

export default publicEn;
