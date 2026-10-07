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
      "Stock Master Analytics screen for a sample shop (screen in French): capital invested 324,500 FCFA, revenue 88,250 FCFA, net profit 18,200 FCFA, average margin 20.6%, 76 units sold in 10 transactions.",
    salesAlt:
      "Stock Master Sales screen (in French): list of recorded sales with the product, quantity, price, total and seller, sample data.",
    caption:
      "Real screenshots of the app (in French), with a sample shop and sample sales.",
  },
  landing: {
    meta: {
      title: "Stock Master — Your shop's stock and sales, on your phone",
      description:
        "Track your stock, record your sales, work with your sellers and understand your business.",
      price: "{{monthly}} per month, or {{best}} for {{term}}",
      trial: "{{days}}-day free trial, then {{price}}.",
      subscription: "Subscription: {{price}}.",
      ogDescription:
        "Stock, sales, team and analytics for shops and small businesses.",
      ogTrial: "{{days}}-day free trial.",
    },
    hero: {
      title: "Track your stock and sales from your phone",
      text: "Stock Master replaces the shop notebook. Add your products, record every sale, and see what is left on the shelves and what you earn, on your own or with your sellers.",
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
        text: "Organise your products by section. Each sale lowers the remaining stock, and the app tells you which products are running low or sold out.",
      },
      sales: {
        title: "Record your sales",
        text: "Choose the product, the quantity and the price, then confirm. Each sale keeps its date and the seller's name.",
      },
      team: {
        title: "Work with your team",
        text: "Invite your sellers with a link and choose what each person can do: sell, manage the catalogue, see the figures. The price does not change with the number of sellers.",
      },
      analytics: {
        title: "Understand your business",
        text: "The Analytics page calculates your revenue, your profit and your margin, and ranks your products and your sellers.",
      },
      alsoIncluded:
        "Also included: the trash to recover a deleted product, the euro ↔ CFA franc converter, your shop's logo and colour, and a notification centre in the app.",
    },
    offline: {
      title: "Network down? You keep selling.",
      steps: {
        open: {
          title: "Open the app while you have network",
          text: "The phone keeps your catalogue and your right to sell for 72 hours.",
        },
        sell: {
          title: "Sell even without a connection",
          text: "Each sale is saved on the device and marked “pending”.",
        },
        sync: {
          title: "The network comes back, the sales are sent",
          text: "Sending is automatic. The server checks the stock; if a sale has a problem, you are told so you can decide.",
        },
      },
      note: "Without network, only selling is possible. Adding products, viewing analytics or managing the team needs a connection. Pending sales stay on the device for up to 14 days.",
    },
    pricing: {
      title: "One subscription, the length you choose",
      text: "All features, for the whole shop. The amount shown is the total paid for the chosen length.",
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
          "The owner chooses a length of 1, 3, 6 or 12 months in the Subscription area. There is no automatic payment: every renewal is voluntary. The price covers the whole shop, whatever the number of sellers.",
        answerTrial:
          "After the {{days}}-day trial, the owner chooses a length of 1, 3, 6 or 12 months in the Subscription area. There is no automatic payment: every renewal is voluntary. The price covers the whole shop, whatever the number of sellers.",
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
