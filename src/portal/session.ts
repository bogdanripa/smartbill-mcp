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

/** Login failed for a reason retrying won't fix (bad credentials, or an MFA/step-up). */
export class PortalAuthError extends Error {
  constructor(message: string) {
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

// ---- login (multi-hop: POST -> /auth/login-key/ -> /) ---------------------
/**
 * Signs in and returns the resulting cookie jar. Throws PortalAuthError if the
 * flow bounces back to the login form (wrong credentials or an MFA/step-up
 * this can't complete).
 */
export async function login(email: string, password: string, fetchImpl: typeof fetch): Promise<PortalCookies> {
  const jar: PortalCookies = {};

  const pageRes = await fetchImpl(`${PORTAL_BASE_URL}/auth/login/`, { redirect: "manual" });
  absorb(jar, pageRes);
  const html = await pageRes.text();
  const tokenMatch = html.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/);
  if (!tokenMatch) {
    throw new PortalAuthError("Could not find the CSRF token on the SmartBill login page.");
  }

  let res = await fetchImpl(`${PORTAL_BASE_URL}/auth/login/?next=/`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: PORTAL_BASE_URL,
      Referer: `${PORTAL_BASE_URL}/auth/login/?next=/`,
      Cookie: cookieHeader(jar),
    },
    body: new URLSearchParams({
      csrfmiddlewaretoken: tokenMatch[1] ?? "",
      username: email,
      password,
      next: "/",
    }),
  });
  absorb(jar, res);

  for (let hop = 0; hop < 6 && res.status >= 300 && res.status < 400; hop++) {
    const location = res.headers.get("location");
    if (!location) break;
    const next = new URL(location, PORTAL_BASE_URL);
    if (next.pathname === "/auth/login/") {
      throw new PortalAuthError(
        "SmartBill rejected the sign-in (wrong email/password, or the account needs a step this cannot perform).",
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
    throw new PortalAuthError("Sign-in completed but SmartBill set no session cookie.");
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
    throw new PortalAuthError(`Integrations page returned HTTP ${status}; cannot read the API token.`);
  }
  const pick = (re: RegExp): string | null => {
    const m = text.match(re);
    return m ? (m[1] ?? "").trim() : null;
  };
  return {
    user: pick(/User-ul meu este\s+(.+?)%0D/),
    token: pick(/Token-ul este\s+(.+?)%0D/),
    cif: pick(/CIF-ul firmei este\s+([A-Z0-9]+)/),
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
