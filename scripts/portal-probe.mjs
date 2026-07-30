#!/usr/bin/env node
// Experimental — NOT part of the MCP server. Probes SmartBill Cloud's internal
// (undocumented, session-authenticated) dashboard API to see whether we can call
// it from our own code with a saved session, re-logging in when the session dies.
//
// Run locally (needs SMARTBILL_USER / SMARTBILL_PWD, which never leave your machine):
//   node scripts/portal-probe.mjs [widget]
// e.g.  node scripts/portal-probe.mjs clients_balance
//
// It stores cookies in .smartbill-session.json next to the repo root, reuses them
// on the next run, and signs in again automatically if the API call is rejected.
//
// No headless browser: this is plain HTTPS form-posting, exactly what the browser
// does. It uses your full Cloud login, so treat .smartbill-session.json as a
// secret and keep it out of git (see .gitignore change in this commit).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://cloud.smartbill.ro";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_FILE = resolve(ROOT, ".smartbill-session.json");

// Widget instance ids are ACCOUNT-SPECIFIC — these are Genezio's, read off the
// dashboard HAR. A real tool would scrape them from GET / after login; for a
// probe against this one account, hardcoding is fine.
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

const widget = process.argv[2] || "clients_balance";
const widgetId = WIDGET_IDS[widget];
if (!widgetId) {
  console.error(`Unknown widget "${widget}". Known: ${Object.keys(WIDGET_IDS).join(", ")}`);
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
    // A logout/expiry sets the cookie to an empty/"deleted" value — drop it.
    if (name && val && val !== '""' && val.toLowerCase() !== "deleted") jar[name] = val;
  }
}

// ---- login ----------------------------------------------------------------
async function login(jar) {
  if (!USER || !PWD) {
    throw new Error("SMARTBILL_USER / SMARTBILL_PWD not set (put them in .env or the environment).");
  }
  console.error("• signing in…");

  // 1. GET the login page → csrftoken cookie + csrfmiddlewaretoken field.
  const pageRes = await fetch(`${BASE}/auth/login/`, { redirect: "manual" });
  absorb(jar, pageRes);
  const html = await pageRes.text();
  const m = html.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/);
  if (!m) throw new Error("could not find csrfmiddlewaretoken on the login page");
  const middlewareToken = m[1];

  // 2. POST the credentials. Django checks Origin/Referer on HTTPS, and matches
  //    the middleware token against the csrftoken cookie.
  const body = new URLSearchParams({
    csrfmiddlewaretoken: middlewareToken,
    username: USER,
    password: PWD,
    next: "/",
  });
  let res = await fetch(`${BASE}/auth/login/?next=/`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: BASE,
      Referer: `${BASE}/auth/login/?next=/`,
      Cookie: cookieHeader(jar),
    },
    body,
  });
  absorb(jar, res);

  // SmartBill's login is multi-hop: POST credentials -> 302 to a one-time
  // /auth/login-key/<token>/ URL -> GET that (it sets the session) -> 302 to /.
  // Follow the chain, absorbing cookies at each hop. A redirect back to the
  // login FORM itself (/auth/login/) is the real failure — bad creds or MFA.
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

  // We should now hold something beyond the CSRF cookie (i.e. a session cookie).
  const sessionCookies = Object.keys(jar).filter((k) => k !== "csrftoken");
  if (sessionCookies.length === 0) {
    throw new Error(
      `login completed the redirect chain but set no session cookie (last status ${res.status}). ` +
        `The widget call would just 401; inspect the flow.`,
    );
  }
  saveJar(jar);
  console.error(`• signed in; cookies now: ${Object.keys(jar).join(", ")}`);
}

// ---- widget call ----------------------------------------------------------
async function callWidget(jar) {
  const res = await fetch(`${BASE}/dashboard/widget/data/${widget}/`, {
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
    body: new URLSearchParams({ widget_dashboard_id: widgetId }),
  });
  const text = await res.text();
  return { res, text };
}

// A response is "not authenticated" if the server bounced us to login (302),
// returned 401/403, or answered 200 with the CSRF/failure sentinel.
function looksUnauthenticated({ res, text }) {
  if (res.status === 401 || res.status === 403) return true;
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location") || "";
    // A redirect anywhere under /auth/ means the session is gone. (Match the
    // path, not a bare "/auth/login" prefix — that also catches /auth/login-key.)
    if (/\/auth\//.test(new URL(loc, BASE).pathname)) return true;
  }
  if (res.status === 200) {
    try {
      const j = JSON.parse(text);
      if (j.csrf_fails === true) return true;
      if (j.successfully === false && !j.clients && !j.hasClients) return true;
    } catch {
      /* non-JSON 200 — treat as fine, let the caller see it */
    }
  }
  return false;
}

// ---- main ------------------------------------------------------------------
(async () => {
  const jar = loadJar();
  const hadSession = Object.keys(jar).length > 0;
  if (hadSession) console.error(`• reusing saved session (${Object.keys(jar).join(", ")})`);
  else console.error("• no saved session");

  let result;
  if (hadSession) {
    result = await callWidget(jar);
    if (looksUnauthenticated(result)) {
      console.error(`• saved session rejected (status ${result.res.status}) → re-authenticating`);
      await login(jar);
      result = await callWidget(jar);
    } else {
      // session still valid — persist any refreshed cookies
      saveJar(jar);
    }
  } else {
    await login(jar);
    result = await callWidget(jar);
  }

  console.error(`• GET ${widget} → HTTP ${result.res.status}`);
  if (looksUnauthenticated(result)) {
    console.error("✗ still not authenticated after logging in — see body below:");
    console.log(result.text);
    process.exit(1);
  }
  // Pretty-print JSON when possible.
  try {
    console.log(JSON.stringify(JSON.parse(result.text), null, 2));
  } catch {
    console.log(result.text);
  }
})().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
