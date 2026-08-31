// Low-level SmartBill Cloud portal session: cookie jar, multi-hop login, the
// integrations-page scrape, and a single request primitive. All I/O goes
// through an injected fetch so this is unit-testable without the network.
//
// Ported from the proven probe (scripts/portal-probe.mjs). The orchestration
// that stores cookies, re-logs-in on expiry, and trips the failure breaker
// lives one layer up (service.ts) — this file only knows how to talk HTTP.

import { ENDPOINTS, type PortalEndpoint, type PortalParams } from "./endpoints.js";

export const PORTAL_BASE_URL = "https://cloud.smartbill.ro";

export type PortalCookies = Record<string, string>;

/**
 * Which step of the portal sign-in failed.
 *
 * Only `credentials` means SmartBill turned the sign-in down. The others are
 * sign-ins that *worked* and then hit something else, and telling someone their
 * password was rejected when it was not sends them to re-type a correct password
 * for ever — which is exactly what happened before this existed.
 */
export type PortalAuthStage =
  /** The login form or endpoint could not be read — SmartBill changed it, or blocked us. */
  | "login-page"
  /** SmartBill turned the sign-in down and said why. `portalText` carries its words. */
  | "credentials"
  /** SmartBill wants a device confirmation code, which this server cannot supply. */
  | "security-code"
  /** Signed in, but no session cookie came back. */
  | "no-session"
  /** Signed in, but the integrations page did not load. */
  | "integrations"
  /** Signed in, but that page carries no API token/CIF — usually a role without API access. */
  | "no-api-token";

export class PortalAuthError extends Error {
  constructor(
    message: string,
    readonly stage: PortalAuthStage = "credentials",
    /**
     * SmartBill's own words for the refusal, when it gave any. Preferred over
     * anything we would write: it distinguishes a wrong password from a locked
     * account or a rate-limit, and it is already in the user's language. Us
     * re-classifying it is how the original bug happened one level down.
     */
    readonly portalText?: string,
  ) {
    super(message);
    this.name = "PortalAuthError";
  }
}

/** The scoped public-API credentials embedded in the integrations page. */
export interface ScrapedApiCredentials {
  user: string | null;
  token: string | null;
  cif: string | null;
}

export interface PortalResponse {
  status: number;
  location: string;
  text: string;
}

// ---- cookie jar -----------------------------------------------------------
export function cookieHeader(jar: PortalCookies): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function absorb(jar: PortalCookies, res: Response): void {
  const setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const line of setCookie) {
    const pair = line.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    // A logout/expiry sets the cookie empty or to "deleted" — drop rather than keep.
    if (name && value && value !== '""' && value.toLowerCase() !== "deleted") jar[name] = value;
  }
}

/** The JSON /auth/login/ajax/ answers with. Only the fields we act on. */
interface AjaxLoginResult {
  successfully?: boolean;
  /** SmartBill's own refusal text, e.g. "Datele de autentificare sunt incorecte." */
  errorText?: string;
  /** The /auth/login-key/<key> hop that actually establishes the session. */
  url?: string;
  force_redirect?: boolean;
  /** Non-null when SmartBill wants a device confirmation code. */
  security_code?: unknown;
}

// ---- login (POST /auth/login/ajax/ -> /auth/login-key/ -> /) --------------
/**
 * Signs in and returns the resulting cookie jar.
 *
 * This posts the **same endpoint the browser posts**, `/auth/login/ajax/`, rather
 * than the plain form. The form version only tells you it failed by bouncing back
 * to the login page, so every refusal looked identical and got reported as a bad
 * password. The AJAX endpoint answers with `successfully` and an `errorText` in
 * SmartBill's own words, which is the difference between "wrong password" and
 * "account locked" — a distinction we should never be guessing at.
 *
 * The response is not itself a session: it carries `force_redirect` and a
 * `/auth/login-key/<key>` URL that has to be followed before the session works.
 * Verified against the live portal — skipping that hop leaves a half-session that
 * gets bounced off the integrations page.
 */
export async function login(email: string, password: string, fetchImpl: typeof fetch): Promise<PortalCookies> {
  const jar: PortalCookies = {};

  const pageRes = await fetchImpl(`${PORTAL_BASE_URL}/auth/login/`, { redirect: "manual" });
  absorb(jar, pageRes);
  const html = await pageRes.text();
  const tokenMatch = html.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/);
  const csrf = tokenMatch?.[1] ?? jar.csrftoken;
  if (!csrf) {
    throw new PortalAuthError(
      "Could not find the CSRF token on the SmartBill login page.", "login-page");
  }

  const ajax = await fetchImpl(`${PORTAL_BASE_URL}/auth/login/ajax/`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRFToken": jar.csrftoken ?? csrf,
      Accept: "application/json, text/javascript, */*; q=0.01",
      Origin: PORTAL_BASE_URL,
      Referer: `${PORTAL_BASE_URL}/auth/login/?next=/`,
      Cookie: cookieHeader(jar),
    },
    body: new URLSearchParams({
      csrfmiddlewaretoken: csrf,
      username: email,
      password,
      next: "/",
      isTrustedDevice: "false",
    }),
  });
  absorb(jar, ajax);

  const raw = await ajax.text();
  let result: AjaxLoginResult;
  try {
    result = JSON.parse(raw) as AjaxLoginResult;
  } catch {
    // Not JSON: the endpoint moved, or something in front of it answered instead.
    throw new PortalAuthError(
      `The SmartBill login endpoint returned HTTP ${ajax.status} and not JSON.`, "login-page");
  }

  if (result.successfully === false) {
    const text = (result.errorText ?? "").trim();
    throw new PortalAuthError(
      text || "SmartBill refused the sign-in without saying why.",
      "credentials",
      text || undefined);
  }

  let res = await fetchImpl(new URL(result.url ?? "/", PORTAL_BASE_URL).toString(), {
    method: "GET",
    redirect: "manual",
    headers: { Cookie: cookieHeader(jar), Referer: `${PORTAL_BASE_URL}/` },
  });
  absorb(jar, res);

  for (let hop = 0; hop < 6 && res.status >= 300 && res.status < 400; hop++) {
    const location = res.headers.get("location");
    if (!location) break;
    const next = new URL(location, PORTAL_BASE_URL);
    if (next.pathname === "/auth/login/") {
      throw new PortalAuthError(
        "SmartBill rejected the sign-in (wrong email/password, or the account needs a step this cannot perform).",
        "credentials",
      );
    }
    res = await fetchImpl(next.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { Cookie: cookieHeader(jar), Referer: `${PORTAL_BASE_URL}/` },
    });
    absorb(jar, res);
  }

  const hasSession = Object.keys(jar).some((name) => name !== "csrftoken");
  if (!hasSession) {
    // security_code is checked HERE rather than up front, on purpose. It reads
    // like a device-confirmation step-up and it is null on a normal sign-in, but
    // that is inference from one observation — failing on it eagerly would break
    // every login if it turns out to be set in some harmless case too. Reaching
    // this point means the sign-in genuinely did not produce a session, so it can
    // only improve the explanation, never cause the failure.
    if (result.security_code != null) {
      throw new PortalAuthError(
        "SmartBill asked for a device confirmation code, which this server cannot supply.",
        "security-code");
    }
    throw new PortalAuthError(
      "Sign-in completed but SmartBill set no session cookie.", "no-session");
  }
  return jar;
}

// ---- integrations scrape (bootstraps the scoped API token) ----------------
export async function scrapeApiCredentials(
  jar: PortalCookies,
  fetchImpl: typeof fetch,
): Promise<ScrapedApiCredentials> {
  const { status, text } = await request(jar, ENDPOINTS.integrations, {}, fetchImpl);
  if (status !== 200) {
    throw new PortalAuthError(
      `Integrations page returned HTTP ${status}; cannot read the API token.`, "integrations");
  }
  // First match wins, so the CURRENT page shape is tried before the old one.
  const pick = (...patterns: RegExp[]): string | null => {
    for (const re of patterns) {
      const value = (text.match(re)?.[1] ?? "").trim();
      if (value) return value;
    }
    return null;
  };

  // SmartBill rebuilt this page: the values used to sit in a Romanian mailto
  // blob ("Token-ul este <token>%0D"), and now live in a JS config object as
  // userKey / properCif / userEmail. Verified against the live page — userKey is
  // byte-identical to the token this server already had stored, and there is
  // only one token-shaped value on the page, so the new API v3 section cannot be
  // picked up by mistake.
  //
  // The old patterns stay as fallbacks. They cost nothing, and an account still
  // being served the previous page must not be told its password is wrong.
  return {
    user: pick(/userEmail\s*:\s*"([^"]+)"/, /User-ul meu este\s+(.+?)%0D/),
    token: pick(/userKey\s*:\s*"([^"]+)"/, /Token-ul este\s+(.+?)%0D/),
    cif: pick(/properCif\s*:\s*"([^"]+)"/, /companyCif\s*:\s*"([^"]+)"/,
              /CIF-ul firmei este\s+([A-Z0-9]+)/),
  };
}

// ---- request primitive ----------------------------------------------------
export async function request(
  jar: PortalCookies,
  endpoint: PortalEndpoint,
  params: PortalParams,
  fetchImpl: typeof fetch,
): Promise<PortalResponse> {
  const url = `${PORTAL_BASE_URL}${endpoint.path}`;
  const common = { Cookie: cookieHeader(jar), Referer: `${PORTAL_BASE_URL}/` };

  let res: Response;
  if (endpoint.method === "GET") {
    res = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: { ...common, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });
  } else {
    res = await fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        ...common,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRFToken": jar.csrftoken ?? "",
        Accept: "application/json, text/javascript, */*; q=0.01",
        Origin: PORTAL_BASE_URL,
      },
      body: new URLSearchParams(endpoint.build ? endpoint.build(params) : {}),
    });
  }
  absorb(jar, res); // pick up any refreshed cookies
  return { status: res.status, location: res.headers.get("location") ?? "", text: await res.text() };
}

/**
 * True when a response means the session is no longer valid: bounced to /auth/,
 * 401/403, or a 200 carrying the CSRF-failure sentinel.
 */
export function isUnauthenticated({ status, location, text }: PortalResponse): boolean {
  if (status === 401 || status === 403) return true;
  if (status >= 300 && status < 400) {
    try {
      if (new URL(location, PORTAL_BASE_URL).pathname.startsWith("/auth/")) return true;
    } catch {
      /* ignore malformed location */
    }
  }
  if (status === 200) {
    try {
      if ((JSON.parse(text) as { csrf_fails?: boolean }).csrf_fails === true) return true;
    } catch {
      /* non-JSON 200 (e.g. the HTML integrations page) is fine */
    }
  }
  return false;
}
