#!/usr/bin/env node
// Experimental — NOT part of the MCP server. Exercises SmartBill Cloud's
// internal (undocumented, session-authenticated) AJAX endpoints so we can see
// their exact request/response shapes before building real tools on them.
//
// This file is the SOURCE OF TRUTH for those request shapes: each entry in
// COMMANDS below mirrors, verbatim, a request captured from the browser. When
// we implement the actual tools, copy the paths and body structures from here.
//
// Run locally (needs SMARTBILL_USER / SMARTBILL_PWD, which never leave your box):
//   node scripts/portal-probe.mjs <command> [--flag value ...]
//   node scripts/portal-probe.mjs help
//
// It signs in, saves cookies to .smartbill-session.json, reuses them next run,
// and re-authenticates automatically if a call is rejected. Plain HTTPS
// form-posting, no headless browser. The session file is a live login — it is
// gitignored; treat it as a secret.
//
// AUTH MODEL NOTE: this uses the full Cloud login (not the scoped API token).
// Decisions about where a real tool runs and how it holds this credential are
// deliberately still open — see the conversation. This script is only the spike.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://cloud.smartbill.ro";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_FILE = resolve(ROOT, ".smartbill-session.json");

// Dashboard widget instance ids are ACCOUNT-SPECIFIC (these are Genezio's, read
// off the dashboard HAR). A real tool would scrape them from GET / after login.
const WIDGET_IDS = {
  sales_simple: "3573425",
  clients_balance: "3573426",
  unpaid_invoices: "3573427",
  expenses_simple: "3573428",
  amounts_to_pay: "3573429",
  activity: "3573430",
  sold_casa: "3573431",
  total_overdue: "3573432",
};

// ---------------------------------------------------------------------------
// COMMANDS: the endpoint catalogue. Each build(flags) returns the POST body as
// a plain object (form-encoded by portalPost). Bodies mirror real captures;
// the odd bits (DataTables scaffolding, the trailing-space "daysOutOfDate "
// key) are reproduced on purpose — do not "tidy" them without testing.
// ---------------------------------------------------------------------------
const COMMANDS = {
  // --- Nomenclator: full customer roster + name substring search -----------
  // GET all: omit --search. Search: --search "DR". Paginate: --start --length.
  clienti: {
    path: "/nomenclator/clienti/ajax/",
    desc: "customer roster + name search (DataTables). row: [status, name, cif, ?, phone, email, ?, clientId]",
    build: (f) => {
      const body = {
        sEcho: "1",
        iColumns: "8",
        sColumns: "",
        iDisplayStart: f.start || "0",
        iDisplayLength: f.length || "30",
        sSearch: JSON.stringify({ client_name: f.search || "" }),
        bRegex: "false",
        iSortingCols: "0",
        displayCodes: "true",
      };
      for (let i = 0; i < 8; i++) {
        body[`mDataProp_${i}`] = String(i);
        body[`sSearch_${i}`] = "";
        body[`bRegex_${i}`] = "false";
        body[`bSearchable_${i}`] = "true";
        body[`bSortable_${i}`] = i === 0 || i === 7 ? "false" : "true";
      }
      return body;
    },
  },

  // --- Raport: unpaid-invoices / aging report ------------------------------
  // Per client + per invoice, with status ("in termen" / "termen depasit"),
  // daysPastDueDate, seriesNumber, value + converted vValue, collected flag.
  // Filter: --from --to (dd/mm/yyyy), --client, --payment-status.
  receivables: {
    path: "/raport/facturi-neincasate/ajax/",
    desc: "aging/receivables report: status + days overdue per invoice, grouped by client, currency-aware",
    build: (f) => {
      const from = f.from || "01/07/2026";
      const to = f.to || "31/07/2026";
      return {
        sSearch: JSON.stringify({
          reportType: 1,
          displayPayments: true,
          periodFilter: 0,
          periodStartDate: from,
          periodEndDate: to,
          clientName: f.client || "",
          paymentStatus: f.paymentStatus ? Number(f.paymentStatus) : 1,
          daysUpToDate: ["0-0", "1-7", "8-14", "15-30", "31-*"],
          "daysOutOfDate ": "1-7;8-30;31-60;61-90;91-*", // trailing space is verbatim
          currencyId: "-1",
          doCurrencyConvertion: false,
          displayBalance: false,
          selectUpToDate: { first: true, second: true, third: true, fourth: true, fifth: true },
          selectOutOfDate: {},
          from,
          to,
        }),
      };
    },
  },

  // --- Raport: outstanding balance per client, point-in-time ---------------
  // The COMPLETE balances list (unlike the top-10 clients_balance widget).
  // `sold` = balance as of --date; `soldAzi` = balance today. One row per
  // (client, currency). Filter: --date, --client, --cif, --include-zero.
  balances: {
    path: "/raport/sume_de_incasat/ajax/",
    desc: "outstanding balance per client as of a date (sold vs soldAzi), all currencies, with grand totals",
    build: (f) => ({
      sSearch: JSON.stringify({
        client: f.client || "",
        date: f.date || "02/07/2026",
        fisa_client_cif: f.cif || "",
        results_per_page: f.length ? Number(f.length) : 200,
        show_sold_curent: true,
        include_zero_sold_clients: f.includeZero === "true",
        include_chitante_fara_factura: true,
        currency: "0",
      }),
    }),
  },

  // --- Raport: client statement ("fisa client") ----------------------------
  // Every document for one client over a date range. Keyed by CIF (client_id
  // NOT required — proven). Also a document search via --document-type /
  // --document-number. Needs --cif OR --client.
  transactions: {
    path: "/raport/lista_tranzactii/ajax/",
    desc: "client statement: every document for one client over a date range (by CIF); also doc search",
    require: (f) => (f.cif || f.client ? null : "needs --cif <cif> or --client <name>"),
    build: (f) => ({
      sSearch: JSON.stringify({
        client: f.client || "",
        from: f.from || "01/01/2026",
        to: f.to || "31/12/2026",
        results_per_page: f.length ? Number(f.length) : 200,
        currency: "0",
        document_type: f.documentType || "",
        document_number: f.documentNumber || "",
        client_id: f.clientId || "", // intentionally empty: CIF alone works
        fisa_client_cif: f.cif || "",
        fisa_client: true,
      }),
    }),
  },

  // --- Raport: balance evolution / ledger ("evolutia soldului") ------------
  // Like the statement, but with a RUNNING balance: balanceEntries[] carry a
  // per-document `sold` plus a synthetic "Sold initial" opening row, and the
  // header sums vanzare (sales) vs incasare (collections). Needs --cif OR
  // --client. Toggles: --include-proforme.
  ledger: {
    path: "/raport/evolutia_soldului/ajax/",
    desc: "client ledger with running balance (balanceEntries[] with per-document sold + opening balance)",
    require: (f) => (f.cif || f.client ? null : "needs --cif <cif> or --client <name>"),
    build: (f) => ({
      sSearch: JSON.stringify({
        client: f.client || "",
        from: f.from || "01/01/2026",
        to: f.to || "31/12/2026",
        results_per_page: f.length ? Number(f.length) : 200,
        include_proforme: f.includeProforme === "true",
        include_chitante_fara_factura: true,
        include_bonuri_fara_factura: true,
        currency: "0",
        document_type: f.documentType || "",
        document_number: f.documentNumber || "",
        fisa_client_cif: f.cif || "",
        fisa_client: true,
      }),
    }),
  },

  // --- Raport: collections received ("incasari") ---------------------------
  // The mirror of `receivables`: money IN. DataTables, 14 columns. Each row is
  // a payment (type e.g. "Ordin plata") linked to the invoice(s) it settled
  // (document_series_name + document_number), with date, value, currency, and
  // an embedded status blob. Per-currency totals/subtotals. Filter: --from --to.
  payments: {
    path: "/raport/incasari/ajax/",
    desc: "collections received (incasari): payments linked to the invoices they settled, with per-currency totals",
    build: (f) => {
      const body = {
        sEcho: "1",
        iColumns: "14",
        sColumns: "",
        iDisplayStart: f.start || "0",
        iDisplayLength: f.length || "30",
        sSearch: JSON.stringify({ from: f.from || "01/07/2026", to: f.to || "31/07/2026", currency: "0" }),
        bRegex: "",
        iSortingCols: "0",
        last_documents_ids: "[]",
      };
      const notSortable = new Set([0, 4, 8, 9, 10, 11, 12, 13]); // verbatim from capture
      for (let i = 0; i < 14; i++) {
        body[`mDataProp_${i}`] = String(i);
        body[`sSearch_${i}`] = "";
        body[`bRegex_${i}`] = "false";
        body[`bSearchable_${i}`] = "true";
        body[`bSortable_${i}`] = notSortable.has(i) ? "false" : "true";
      }
      return body;
    },
  },

  // --- Raport: product sales ("vanzari produse") ---------------------------
  // Grouped by product: quantity, average price, value/total by currency, and
  // a nested documentsList[] (each line: clientId, clientCif, document number,
  // docType incl. "factura storno", signed quantities/values). Filter:
  // --from --to, --document-type. Paginate: --page --length.
  product_sales: {
    path: "/raport/vanzari-produse/ajax/",
    desc: "product-sales report: per-product totals by currency + nested per-document lines (with clientId)",
    build: (f) => ({
      sSearch: JSON.stringify({
        reportType: 1,
        from: f.from || "01/06/2026",
        to: f.to || "30/06/2026",
        currencyId: "-1",
        doCurrencyConvertion: false,
        documentType: f.documentType || "",
        page: f.page ? Number(f.page) : 1,
        results_per_page: f.length ? Number(f.length) : 10,
        products_type: "0",
        save_filter: true,
      }),
    }),
  },

  // --- Client details lookup by name + CIF ---------------------------------
  // NOTE: plain form fields, NOT an sSearch JSON blob. Returns the full client
  // record: address, city/county/country, reg_com, email, iban/bank,
  // is_vat_payer. Needs --cif and/or --client.
  client_details: {
    path: "/documente/get_document_client/",
    desc: "full client record (address, reg_com, email, iban, is_vat_payer) by name + CIF — plain form body",
    require: (f) => (f.cif || f.client ? null : "needs --cif <cif> and/or --client <name>"),
    build: (f) => ({ client_name: f.client || "", client_cif: f.cif || "" }),
  },
};

// Dashboard widgets: one command each, sharing the widget-id map.
for (const [name, id] of Object.entries(WIDGET_IDS)) {
  COMMANDS[name] = {
    path: `/dashboard/widget/data/${name}/`,
    desc: `dashboard widget: ${name}`,
    build: () => ({ widget_dashboard_id: id }),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    }
  }
  return out;
}

const command = process.argv[2];
if (!command || command === "help" || command === "--help") {
  console.log("Usage: node scripts/portal-probe.mjs <command> [--flag value ...]\n\ncommands:");
  for (const [name, c] of Object.entries(COMMANDS)) console.log(`  ${name.padEnd(18)} ${c.desc}`);
  process.exit(command ? 0 : 2);
}
const spec = COMMANDS[command];
if (!spec) {
  console.error(`Unknown command "${command}". Try: node scripts/portal-probe.mjs help`);
  process.exit(2);
}
const flags = parseFlags(process.argv.slice(3));
const missing = spec.require ? spec.require(flags) : null;
if (missing) {
  console.error(`"${command}" ${missing}`);
  process.exit(2);
}

// ---- credentials (from .env or the environment; never persisted) ----------
function loadEnv() {
  const env = { ...process.env };
  const envFile = resolve(ROOT, ".env");
  if (existsSync(envFile)) {
    for (const raw of readFileSync(envFile, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in env)) env[key] = val;
    }
  }
  return env;
}
const ENV = loadEnv();
const USER = ENV.SMARTBILL_USER;
const PWD = ENV.SMARTBILL_PWD;

// ---- cookie jar (persisted to disk) ---------------------------------------
function loadJar() {
  if (existsSync(SESSION_FILE)) {
    try {
      return JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    } catch {
      /* corrupt file → start fresh */
    }
  }
  return {};
}
function saveJar(jar) {
  writeFileSync(SESSION_FILE, JSON.stringify(jar, null, 2) + "\n");
}
function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}
function absorb(jar, res) {
  const set = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const line of set) {
    const pair = line.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (name && val && val !== '""' && val.toLowerCase() !== "deleted") jar[name] = val;
  }
}

// ---- login (multi-hop: POST -> /auth/login-key/ -> /) ---------------------
async function login(jar) {
  if (!USER || !PWD) {
    throw new Error("SMARTBILL_USER / SMARTBILL_PWD not set (put them in .env or the environment).");
  }
  console.error("• signing in…");

  const pageRes = await fetch(`${BASE}/auth/login/`, { redirect: "manual" });
  absorb(jar, pageRes);
  const html = await pageRes.text();
  const m = html.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/);
  if (!m) throw new Error("could not find csrfmiddlewaretoken on the login page");

  let res = await fetch(`${BASE}/auth/login/?next=/`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: BASE,
      Referer: `${BASE}/auth/login/?next=/`,
      Cookie: cookieHeader(jar),
    },
    body: new URLSearchParams({
      csrfmiddlewaretoken: m[1],
      username: USER,
      password: PWD,
      next: "/",
    }),
  });
  absorb(jar, res);

  for (let hop = 0; hop < 6 && res.status >= 300 && res.status < 400; hop++) {
    const location = res.headers.get("location");
    if (!location) break;
    const next = new URL(location, BASE);
    if (next.pathname === "/auth/login/") {
      throw new Error(
        `login bounced back to the sign-in form (hop ${hop}). ` +
          `Wrong credentials, or the account has MFA / a step this script can't do.`,
      );
    }
    console.error(`• follow: ${next.pathname}${next.search}`);
    res = await fetch(next.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { Cookie: cookieHeader(jar), Referer: `${BASE}/` },
    });
    absorb(jar, res);
  }

  const sessionCookies = Object.keys(jar).filter((k) => k !== "csrftoken");
  if (sessionCookies.length === 0) {
    throw new Error(
      `login completed the redirect chain but set no session cookie (last status ${res.status}).`,
    );
  }
  saveJar(jar);
  console.error(`• signed in; cookies now: ${Object.keys(jar).join(", ")}`);
}

// ---- generic authenticated form POST --------------------------------------
async function portalPost(jar, path, bodyObj) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRFToken": jar.csrftoken || "",
      Accept: "application/json, text/javascript, */*; q=0.01",
      Origin: BASE,
      Referer: `${BASE}/`,
      Cookie: cookieHeader(jar),
    },
    body: new URLSearchParams(bodyObj),
  });
  const text = await res.text();
  return { res, text };
}

function looksUnauthenticated({ res, text }) {
  if (res.status === 401 || res.status === 403) return true;
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location") || "";
    if (/\/auth\//.test(new URL(loc, BASE).pathname)) return true;
  }
  if (res.status === 200) {
    try {
      const j = JSON.parse(text);
      if (j.csrf_fails === true) return true;
    } catch {
      /* non-JSON 200 — let the caller see it */
    }
  }
  return false;
}

// ---- main ------------------------------------------------------------------
(async () => {
  const jar = loadJar();
  const hadSession = Object.keys(jar).length > 0;
  console.error(hadSession ? `• reusing saved session (${Object.keys(jar).join(", ")})` : "• no saved session");

  const doCall = (j) => portalPost(j, spec.path, spec.build(flags));

  let result;
  if (hadSession) {
    result = await doCall(jar);
    if (looksUnauthenticated(result)) {
      console.error(`• saved session rejected (status ${result.res.status}) → re-authenticating`);
      await login(jar);
      result = await doCall(jar);
    } else {
      saveJar(jar); // persist any refreshed cookies
    }
  } else {
    await login(jar);
    result = await doCall(jar);
  }

  console.error(`• ${command}  POST ${spec.path} → HTTP ${result.res.status}`);
  if (looksUnauthenticated(result)) {
    console.error("✗ still not authenticated after logging in — body below:");
    console.log(result.text);
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(JSON.parse(result.text), null, 2));
  } catch {
    console.log(result.text);
  }
})().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
