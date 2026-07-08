#!/usr/bin/env node
import fs from "node:fs";
import { execSync } from "node:child_process";

const src = execSync("git show HEAD:js/credit.js", { encoding: "utf8" });

const OVERVIEW_FUNCS = new Set([
  "readOverviewDateRange",
  "getOverviewFilterForLinks",
  "getOverviewDateRange",
  "initOverviewPanel",
  "overviewPeriodOutstanding",
  "normalizeOverviewPeriodData",
  "overviewCacheKey",
  "applyOverviewPeriodData",
  "renderOverviewCustomerRows",
  "setOverviewPeriodStats",
  "loadOverviewPeriodActivity",
]);

const RECORD_FUNCS = new Set([
  "initRecordSalePanel",
  "findCustomerSuggestionByName",
  "syncQuickPaymentPanel",
  "handleQuickPayment",
  "buildCustomerSuggestions",
  "filterCustomerSuggestions",
  "setComboboxOpen",
  "renderCustomerSuggestions",
  "highlightComboboxOption",
  "selectCustomerSuggestion",
  "initCustomerCombobox",
  "loadCustomerNames",
  "handleCreditSubmit",
]);

const CUSTOMER_FUNCS = new Set([
  "applyCustomerPeriodFromUrl",
  "initCustomerView",
  "getCustomerViewFilter",
  "updateCustomerFilterSummary",
  "resetCustomerPeriodFilter",
  "initCustomerViewFilter",
  "updateSettleBalanceBanner",
  "initCustomerSettlePanel",
  "escapeIlikePattern",
  "pickCustomerContact",
  "renderCustomerMeta",
  "setCustomerNameEditable",
  "applyCustomerDisplayName",
  "openCustomerEditModal",
  "closeCustomerEditModal",
  "initCustomerInfoEdit",
  "isCustomerNameTakenByOther",
  "saveCustomerContact",
  "resolveCustomerIds",
  "creditSummaryAssetUrl",
  "sortSummaryEntriesByDate",
  "updateCreditSummaryPrintButton",
  "buildCreditSummaryLedgerRows",
  "creditSummaryReportHeader",
  "buildCreditSummaryPrintHtml",
  "runCreditSummaryPrint",
  "handleCreditSummaryPrintClick",
  "buildPeriodScopedSummary",
  "renderLifetimeBreakdowns",
  "applyLifetimeSummary",
  "loadCustomerDetail",
  "handleSettle",
  "initCreditDeleteHandlers",
  "showCustomerDetailMessage",
  "deleteCreditEntry",
  "deleteCreditPayment",
  "pickContactFromRows",
]);

const fnRegex = /^((?:async )?function (\w+)\([^)]*\) \{)/gm;
const matches = [];
let m;
while ((m = fnRegex.exec(src)) !== null) {
  matches.push({ index: m.index, name: m[2] });
}

const parts = matches.map((match, i) => {
  const start = match.index;
  const end = i + 1 < matches.length ? matches[i + 1].index : src.length;
  return { name: match.name, code: src.slice(start, end).trimEnd() };
});

const preamble = src.slice(0, matches[0].index).trimEnd();

function bucket(name) {
  if (OVERVIEW_FUNCS.has(name)) return "overview";
  if (RECORD_FUNCS.has(name)) return "record";
  if (CUSTOMER_FUNCS.has(name)) return "customer";
  return "core";
}

const buckets = { core: [], overview: [], record: [], customer: [] };
for (const p of parts) buckets[bucket(p.name)].push(p.code);

let corePreamble = preamble
  .replace(/^const \{ filterEntriesByRange, sumAmount, createBreakdownPager \} = CreditCustomerDetail;\n\n/, "")
  .replace(/, CreditCustomerDetail,/, ",")
  .replace(/, PrintUtils/, "")
  .replace(/let overviewRequestId = 0;\n\n/, "")
  .replace(/const OVERVIEW_EMPTY[\s\S]*?\);\n\n/, "")
  .replace(/let customerName = "";\n/, "")
  .replace(/let customerId = null;\n/, "")
  .replace(/let customerIds = \[\];\n/, "")
  .replace(/let customerOutstandingDue = 0;\n/, "")
  .replace(/let customerPrepaidBalance = 0;\n/, "")
  .replace(/let customerNetBalance = 0;\n/, "")
  .replace(/let customerContact = \{ mobile: "", address: "" \};\n/, "")
  .replace(/let customerVehicleNos = \[\];\n/, "")
  .replace(/let lastCustomerSummary = null;\n/, "")
  .replace(/let lastCustomerSummaryContext = null;\n/, "")
  .replace(/let creditSummaryPrintBusy = false;\n/, "")
  .replace(/const CREDIT_SUMMARY_PRINT_CSS = [^\n]+\n/, "")
  .replace(/let creditPager = null;\n/, "")
  .replace(/let paymentPager = null;\n/, "")
  .replace(/let customerPeriodFilterApi = null;\n\n/, "")
  .replace(/let customerSuggestions = \[\];\n/, "")
  .replace(/let customerComboboxActiveIndex = -1;\n/, "")
  .replace(/let customerComboboxMatches = \[\];\n/, "")
  .replace(/let quickPaymentCustomerId = null;\n/, "")
  .replace(/let quickPaymentNetBalance = 0;\n/, "")
  .replace(/document\.addEventListener\("DOMContentLoaded"[\s\S]*$/m, "");

const creditStateBlock = `const creditState = {
  customerName: "",
  customerId: null,
  customerIds: [],
  customerOutstandingDue: 0,
  customerPrepaidBalance: 0,
  customerNetBalance: 0,
  customerContact: { mobile: "", address: "" },
  customerVehicleNos: [],
  lastCustomerSummary: null,
  lastCustomerSummaryContext: null,
  creditSummaryPrintBusy: false,
};`;

const coreFuncs = buckets.core.map((code) => {
  if (code.startsWith("function isCustomerView")) {
    return `function isCustomerView() {
  return Boolean(creditState.customerName);
}`;
  }
  if (code.startsWith("function updateCustomerBalanceState")) {
    return `function updateCustomerBalanceState(amountDue, prepaidBalance) {
  creditState.customerOutstandingDue = Number(amountDue) || 0;
  creditState.customerPrepaidBalance = Number(prepaidBalance) || 0;
  creditState.customerNetBalance = creditState.customerOutstandingDue - creditState.customerPrepaidBalance;
}`;
  }
  if (code.startsWith("function initListView")) {
    return `function initListView() {
  setSidebarMode("list");
  setCustomerToolbarVisible(false);
  hideCustomerPanels();

  if (typeof initPageSections === "function") {
    initPageSections({
      navItemSelector: "#credit-list-nav .settings-nav-item",
      panelSelector: "#credit-panel-overview, #credit-panel-record, #credit-panel-outstanding",
      defaultSection: "overview",
      validSections: ["overview", "record", "outstanding"],
      onSectionChange: (section) => {
        void ensureListTab(section);
      },
    });
  }

  const hash = (location.hash || "").replace(/^#/, "");
  const initial = ["overview", "record", "outstanding"].includes(hash) ? hash : "overview";
  void ensureListTab(initial);
}`;
  }
  if (code.startsWith("function refreshCreditPortfolioViews")) {
    return `function refreshCreditPortfolioViews() {
  if (isCustomerView()) return;
  if (listTabReady.outstanding) loadCreditLedger(true);
  if (window.CreditOverview?.isReady?.()) window.CreditOverview.refresh();
}`;
  }
  return code;
});

const loaderBlock = `const LIST_TAB_SCRIPTS = { overview: "js/creditOverview.js", record: "js/creditRecord.js" };
const listTabReady = { overview: false, record: false, outstanding: false };

async function ensureListTab(section) {
  if (section === "outstanding") {
    if (!listTabReady.outstanding) {
      initOutstandingTab();
      listTabReady.outstanding = true;
    }
    return;
  }
  const src = LIST_TAB_SCRIPTS[section];
  if (!src || listTabReady[section]) return;
  await loadScript(src);
  if (section === "overview") window.CreditOverview?.init?.();
  if (section === "record") window.CreditRecord?.init?.();
  listTabReady[section] = true;
}

function initOutstandingTab() {
  initPaginationControls();
  const onCreditSearch = debounce((value) => {
    creditPagination.searchQuery = value;
    creditPagination.offset = 0;
    renderLedgerPage(true);
  }, 150);
  document.getElementById("credit-search")?.addEventListener("input", (e) => {
    onCreditSearch((e.target.value || "").trim().toLowerCase());
  });
  void loadCreditLedger(true);
}

async function ensureCreditCustomer() {
  await loadScript("js/creditCustomerDetail.js");
  await loadScript("js/printUtils.js");
  await loadScript("js/creditCustomer.js");
  return window.CreditCustomer.init();
}`;

const creditPageBlock = `window.CreditPage = {
  state: creditState,
  get isAdmin() { return isAdmin; },
  isCustomerView,
  setSidebarMode,
  setCustomerToolbarVisible,
  hideCustomerPanels,
  customerDetailUrl,
  customerSummaryUrl,
  formatCustomerBalanceDisplay,
  customerHasAdvance,
  getCustomerBalanceLabel,
  applyCustomerBalanceHero,
  updateCustomerBalanceState,
  invalidateCreditCaches,
  invalidateAndRefreshCreditPortfolio,
  refreshCreditPortfolioViews,
};`;

const domBlock = `document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    pageName: "credit",
  });
  if (!auth) return;

  isAdmin = auth.role === "admin";
  applyRoleVisibility(auth.role);

  const params = new URLSearchParams(window.location.search);
  creditState.customerName = (params.get("name") || "").trim();
  creditState.customerId = params.get("id") || null;

  if (isCustomerView()) {
    await ensureCreditCustomer();
    return;
  }

  initListView();
});`;

const core = [corePreamble, creditStateBlock, ...coreFuncs, loaderBlock, creditPageBlock, domBlock].join("\n\n");

function patchCustomerCode(code) {
  const vars = [
    "customerName",
    "customerId",
    "customerIds",
    "customerOutstandingDue",
    "customerPrepaidBalance",
    "customerNetBalance",
    "customerContact",
    "customerVehicleNos",
    "lastCustomerSummary",
    "lastCustomerSummaryContext",
    "creditSummaryPrintBusy",
  ];
  let out = code;
  for (const v of vars) {
    out = out.replace(new RegExp("\\b" + v + "\\b", "g"), `page().state.${v}`);
  }
  return out
    .replace(/\bsetSidebarMode\(/g, "page().setSidebarMode(")
    .replace(/\bsetCustomerToolbarVisible\(/g, "page().setCustomerToolbarVisible(")
    .replace(/\bhideCustomerPanels\(/g, "page().hideCustomerPanels(")
    .replace(/\binvalidateCreditCaches\(/g, "page().invalidateCreditCaches(")
    .replace(/\binvalidateAndRefreshCreditPortfolio\(/g, "page().invalidateAndRefreshCreditPortfolio(")
    .replace(/\brefreshCreditPortfolioViews\(/g, "page().refreshCreditPortfolioViews(")
    .replace(/\bcustomerDetailUrl\(/g, "page().customerDetailUrl(")
    .replace(/\bcustomerSummaryUrl\(/g, "page().customerSummaryUrl(")
    .replace(/\bformatCustomerBalanceDisplay\(/g, "page().formatCustomerBalanceDisplay(")
    .replace(/\bcustomerHasAdvance\(/g, "page().customerHasAdvance(")
    .replace(/\bgetCustomerBalanceLabel\(/g, "page().getCustomerBalanceLabel(")
    .replace(/\bapplyCustomerBalanceHero\(/g, "page().applyCustomerBalanceHero(")
    .replace(/\bupdateCustomerBalanceState\(/g, "page().updateCustomerBalanceState(")
    .replace(/\bisCustomerView\(/g, "page().isCustomerView(")
    .replace(/\bisAdmin\b/g, "page().isAdmin")
    .replace(/page\(\)\.state\.(\w+):/g, "$1:");
}

const overview = `/* global supabaseClient, formatCurrency, AppCache, AppError, escapeHtml, createDateRangeFilter, readDateRangeFromControls, setFilterState, getRangeForSelection */

(function () {
  const page = () => window.CreditPage;
  let overviewRequestId = 0;
  let ready = false;
  const OVERVIEW_EMPTY = Object.freeze({ credit_taken: 0, settled: 0, overdue: 0, customers: [] });

${buckets.overview.join("\n\n").replace(/\bcustomerSummaryUrl\(/g, "page().customerSummaryUrl(")}

  function init() {
    if (ready) return;
    initOverviewPanel();
    ready = true;
  }

  window.CreditOverview = {
    init,
    isReady: () => ready,
    refresh: () => {
      void loadOverviewPeriodActivity();
    },
  };
})();
`;

const record = `/* global supabaseClient, AppError, escapeHtml, formatCurrency, formatDisplayDate, getLocalDateString, initPersistedDateInput, finishRecordFormSave, savePersistedDate, RECORD_DATE_KEYS, syncFuelSelectStyle */

(function () {
  const page = () => window.CreditPage;
  let ready = false;
  let customerSuggestions = [];
  let customerComboboxActiveIndex = -1;
  let customerComboboxMatches = [];
  let quickPaymentCustomerId = null;
  let quickPaymentNetBalance = 0;

${buckets.record
  .join("\n\n")
  .replace(/\bcustomerDetailUrl\(/g, "page().customerDetailUrl(")
  .replace(/\binvalidateAndRefreshCreditPortfolio\(/g, "page().invalidateAndRefreshCreditPortfolio(")
  .replace(/\binvalidateCreditCaches\(/g, "page().invalidateCreditCaches(")}

  function init() {
    if (ready) return;
    const form = document.getElementById("credit-form");
    if (form) form.addEventListener("submit", (e) => handleCreditSubmit(e));
    const transactionDateInput = document.getElementById("credit-date");
    if (transactionDateInput) initPersistedDateInput(transactionDateInput, RECORD_DATE_KEYS.creditTransaction);
    initRecordSalePanel();
    initCustomerCombobox();
    void loadCustomerNames();
    ready = true;
  }

  window.CreditRecord = { init, isReady: () => ready };
})();
`;

const customer = `/* global supabaseClient, formatCurrency, formatDisplayDate, getLocalDateString, AppCache, AppError, escapeHtml, CreditCustomerDetail, initPageSections, createDateRangeFilter, readDateRangeFromControls, formatDateRangeLabel, setFilterState, PumpSettings, loadPumpSettings, AppConfig, CacheInvalidation, formatNumberPlain, initPersistedDateInput, savePersistedDate, RECORD_DATE_KEYS, PrintUtils, setCustomRangeVisibility */

(function () {
  const page = () => window.CreditPage;
  const { filterEntriesByRange, sumAmount, createBreakdownPager } = CreditCustomerDetail;
  let creditPager = null;
  let paymentPager = null;
  let customerPeriodFilterApi = null;
  const CREDIT_SUMMARY_PRINT_CSS = "css/credit-summary-print.css?v=1";

${patchCustomerCode(buckets.customer.join("\n\n"))}

  async function init() {
    await initCustomerView();
  }

  window.CreditCustomer = { init };
})();
`;

fs.writeFileSync("js/credit.js", core);
fs.writeFileSync("js/creditOverview.js", overview);
fs.writeFileSync("js/creditRecord.js", record);
fs.writeFileSync("js/creditCustomer.js", customer);

for (const f of ["js/credit.js", "js/creditOverview.js", "js/creditRecord.js", "js/creditCustomer.js"]) {
  const size = fs.statSync(f).size;
  console.log(f, size);
}
