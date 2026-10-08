import type analyticsFr from "../fr/analytics";
import type { Translation } from "../types";

const analyticsEn: Translation<typeof analyticsFr> = {
  title: "Analytics",
  subtitle: "What needs your attention, your sales and what sells.",
  noPermission: "You do not have permission to view analytics.",
  loading: "Loading…",
  retry: "Try again",
  periodLabel: "Period",
  currentMonthOption: "{{label}} (in progress)",
  freshness: "Server data at {{time}}",
  unsyncedNote:
    "Sales recorded offline and not yet synchronised are not counted yet.",
  unsyncedPending_one: "{{n}} local sale waiting to be synchronised.",
  unsyncedPending_other: "{{n}} local sales waiting to be synchronised.",
  recordedSalesNote:
    "Amounts of recorded sales, not necessarily money received.",
  watch: {
    title: "To watch",
    empty:
      "Nothing urgent: no stock-outs, no estimated risk and no product without recent sales.",
    seeAll: "See the {{count}} products concerned",
    andOthers_one: "and {{n}} other product",
    andOthers_other: "and {{n}} other products",
    priceFact: "{{name}}: estimated gain {{gain}}",
    stockFact: "{{name}}: {{remaining}}",
    kinds: {
      out: {
        title: "Out of stock",
        reason: "Current stock is 0: this product can no longer be sold.",
        count_one: "{{n}} product sold out",
        count_other: "{{n}} products sold out",
      },
      soon: {
        title: "Running out soon",
        reason:
          "About {{days}} days of stock or less, at the pace of recorded sales.",
        count_one: "{{n}} product to restock",
        count_other: "{{n}} products to restock",
      },
      price: {
        title: "Price to check",
        reason:
          "Over the period, sales bring in less than the current purchase price.",
        count_one: "{{n}} product sold at a loss",
        count_other: "{{n}} products sold at a loss",
      },
      low: {
        title: "Low stock",
        reason:
          "80% of the initial stock sold; not enough sales to estimate the days left.",
        count_one: "{{n}} product",
        count_other: "{{n}} products",
      },
      stale: {
        title: "No recent sales",
        reason:
          "No sales recorded for {{days}} days, although there is stock left.",
        count_one: "{{n}} product",
        count_other: "{{n}} products",
      },
    },
    actions: {
      restock: "Add stock",
      reviewPrice: "Review the price",
      viewProduct: "View the product",
    },
  },
  sales: {
    title: "Your sales",
    revenue: "Sales amount",
    count: "Number of sales",
    gain: "Estimated gain",
    gainUnknown: "Purchase cost unknown for some deleted products.",
    gainHint:
      "Sales minus the current purchase price of the products sold. This is not an accounting profit.",
    units_one: "{{n}} unit sold",
    units_other: "{{n}} units sold",
    periodInProgress: "From {{from}} to {{to}} (month in progress)",
    periodClosed: "From {{from}} to {{to}}",
    compareTo: "Compared with {{from}} – {{to}}",
    compareSameElapsed: "same elapsed time of the previous month",
    totalPrefix: "Month total",
    perDayPrefix: "Per day",
    prefixed: "{{prefix}}:",
    perDayValue: "{{value}} per day",
    durations:
      "{{days}}-day month against {{previousDays}} days: the total depends on the length; read the pace “per day”.",
    previousZero: "against {{amount}}: no percentage",
    changeUp: "+{{pct}}%",
    changeDown: "−{{pct}}%",
    changeFlat: "stable",
    previousValue: "before: {{value}}",
    noComparison: {
      before_creation:
        "No comparison: the shop did not exist yet at the start of the previous period.",
      unequal_length:
        "No comparison today: the previous month is shorter than the time already elapsed.",
      none: "No comparable period.",
    },
  },
  sells: {
    title: "What sells",
    trendTitle: "Sales per day",
    trendSummary_one: "{{total}} over {{n}} day; best day: {{best}}.",
    trendSummary_other: "{{total}} over {{n}} days; best day: {{best}}.",
    trendNone_one: "No sales over {{n}} day.",
    trendNone_other: "No sales over {{n}} days.",
    bestDay: "{{date}} ({{amount}})",
    barTitle_one: "{{date}}: {{amount}} · {{n}} sale",
    barTitle_other: "{{date}}: {{amount}} · {{n}} sales",
    trendTable: "See the figures day by day",
    day: "Day",
    amount: "Amount",
    salesCount: "Sales",
    topTitle: "The 5 products that bring in the most",
    topEmpty: "No sales over this period.",
    product: "Product",
    quantity: "Quantity",
    currentStock: "Current stock",
    currentStockHint: "Today's stock, whatever the period chosen.",
    deleted: "deleted",
    unnamed: "Name not kept",
  },
  stock: {
    title: "Current stock and sales pace",
    windowNote:
      "Pace calculated over the last {{days}} completed days ({{from}} – {{to}}), at the pace of recorded sales. Days when the product was missing, the season and supplier lead times are not known.",
    sections: {
      out: "Stock-out observed (stock at 0)",
      soon: "Estimated risk of running out soon",
      low: "Low stock (80% threshold)",
      stale: "No sales recorded recently",
      recent: "Recently added, not sold yet",
      price: "Price to check",
    },
    sectionCount: "{{title}} ({{n}})",
    remaining: "{{n}} in stock",
    daysLeft: "≈ {{days}} days of stock",
    perDay: "{{avg}} sold / day",
    notEnough: "Not enough sales to estimate",
    invalidQuantities: "Invalid sale quantities: no estimate",
    staleLabel: "No sales recorded for {{days}} days",
    recentLabel: "Added during the observed period",
    priceFacts_one:
      "{{revenue}} of sales for {{n}} unit; current purchase price {{cost}} per unit; estimated gain {{gain}}.",
    priceFacts_other:
      "{{revenue}} of sales for {{n}} units; current purchase price {{cost}} per unit; estimated gain {{gain}}.",
    shownOf_one: "{{shown}} shown out of {{total}}",
    shownOf_other: "{{shown}} shown out of {{total}}",
    showMore_one: "Show the next one",
    showMore_other: "Show the next {{count}}",
    loadError: "The rest of the list could not be loaded.",
    noneInSection: "No products.",
  },
  details: {
    title: "Details",
    open: "Products, sellers and history",
    summary: "{{title}}: {{open}}",
    allProducts: "All products sold · {{month}}",
    product: "Product",
    sold: "Sold",
    amount: "Amount",
    estimatedGain: "Estimated gain",
    currentStock: "Current stock",
    unknownCost: "Purchase cost unknown (deleted products)",
    sellersTitle: "Sales by seller · {{month}}",
    sellerSales_one: "{{n}} sale",
    sellerSales_other: "{{n}} sales",
    sellerUnits_one: "{{n}} unit",
    sellerUnits_other: "{{n}} units",
    historyTitle: "History by month",
    month: "Month",
    sales: "Sales",
    units: "Units",
    sinceStart: "Since the start",
    salesAmount: "Sales amount",
    salesCount: "Number of sales",
    products: "Products",
    capital: "Capital invested",
    profitAll: "Estimated profit (all periods)",
  },
  monthly: {
    title: "Monthly history",
    text: "Download all the sales of a month, with a summary and breakdowns by product and by seller.",
    loading: "Loading available months…",
    month: "Month",
    inProgress: " (in progress)",
    noSales: "no sales",
    salesCount_one: "{{n}} sale",
    salesCount_other: "{{n}} sales",
    option: "{{month}}{{inProgress}} — {{sales}}",
    preparing: "Preparing…",
    download: "Download as {{format}}",
    downloaded: "{{format}} file for {{month}} downloaded.",
    emptyMonth:
      "No sales recorded for this month: the file will only contain the summary, at zero.",
    currentMonth:
      "Month in progress: the file reflects the situation at the time of download.",
    offline: "Downloading needs an Internet connection.",
    pendingNote:
      "Sales still waiting to be synchronised on a device are not included in the report.",
    pendingDevice_one:
      "This device has {{n}}: synchronise it before downloading.",
    pendingDevice_other:
      "This device has {{n}}: synchronise them before downloading.",
    timeZone:
      "Dates and month boundaries: {{timeZone}} time zone, as in the analytics.",
    errors: {
      generic: "The file could not be prepared. Try again.",
      network:
        "The server cannot be reached. Check your connection, then try again.",
      subscription:
        "This shop's subscription is not active: downloading is unavailable.",
      forbidden:
        "Your current role or rights do not allow you to download this history.",
      monthInvalid: "This month is not available.",
      pdfCharacters:
        "Some names cannot be reproduced faithfully in PDF. Download the Excel version.",
      rateLimited:
        "Too many history downloads in a short time. Try again later.",
      busy: "Other reports are being prepared. Try again in a few seconds.",
      dataChanged:
        "Some sales changed during the preparation. Try again in a moment.",
      server:
        "The server could not prepare the file. Try again in a few moments.",
    },
  },
};

export default analyticsEn;
