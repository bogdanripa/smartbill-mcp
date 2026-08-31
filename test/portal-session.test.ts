import { describe, expect, it } from "vitest";
import { ENDPOINTS } from "../src/portal/endpoints.js";
import { authFailureMessage } from "../src/oauth/routes.js";
import {
  cookieHeader,
  isUnauthenticated,
  login,
  PortalAuthError,
  type PortalAuthStage,
  request,
  scrapeApiCredentials,
  type PortalCookies,
} from "../src/portal/session.js";

// A tiny scriptable fetch: each call shifts the next handler off the queue.
function scriptedFetch(handlers: Array<(url: string, init?: RequestInit) => Response>): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const handler = handlers[i++];
    if (!handler) throw new Error(`unexpected fetch call #${i} to ${String(input)}`);
    return handler(String(input), init);
  }) as typeof fetch;
}

function res(
  status: number,
  { body = "", location, setCookie }: { body?: string; location?: string; setCookie?: string[] } = {},
): Response {
  const headers = new Headers();
  if (location) headers.set("location", location);
  const r = new Response(status >= 300 && status < 400 ? null : body, { status, headers });
  // Node's Headers supports getSetCookie(); stub the values we want it to report.
  if (setCookie) (r.headers as unknown as { getSetCookie: () => string[] }).getSetCookie = () => setCookie;
  else if (typeof r.headers.getSetCookie !== "function")
    (r.headers as unknown as { getSetCookie: () => string[] }).getSetCookie = () => [];
  return r;
}

describe("portal endpoint builders", () => {
  it("keeps the DataTables column scaffolding for the client roster", () => {
    const body = ENDPOINTS.clients.build!({ search: "DR", length: 30 });
    expect(body.iColumns).toBe("8");
    expect(body.iDisplayLength).toBe("30");
    expect(JSON.parse(body.sSearch)).toEqual({ client_name: "DR" });
    expect(body.bSortable_0).toBe("false"); // status column not sortable
    expect(body.bSortable_1).toBe("true");
  });

  it("preserves the trailing-space daysOutOfDate key on the receivables report", () => {
    const body = ENDPOINTS.receivables.build!({ from: "01/07/2026", to: "31/07/2026" });
    const search = JSON.parse(body.sSearch) as Record<string, unknown>;
    expect(search["daysOutOfDate "]).toBe("1-7;8-30;31-60;61-90;91-*");
    expect(search.periodStartDate).toBe("01/07/2026");
  });

  it("pages the receivables report inside sSearch, never via DataTables keys", () => {
    // Omitting a page size makes SmartBill serve 10 clients silently, and the
    // DataTables/top-level spellings are ignored by this endpoint — so the keys
    // have to be these, in here.
    const body = ENDPOINTS.receivables.build!({ from: "01/07/2026", to: "31/07/2026" });
    const search = JSON.parse(body.sSearch) as Record<string, unknown>;
    expect(search.results_per_page).toBe(200);
    expect(search.page).toBe(1);
    expect(body.iDisplayLength).toBeUndefined();
    expect(body.results_per_page).toBeUndefined();

    const paged = ENDPOINTS.receivables.build!({ length: 50, page: 3 });
    const pagedSearch = JSON.parse(paged.sSearch) as Record<string, unknown>;
    expect(pagedSearch.results_per_page).toBe(50);
    expect(pagedSearch.page).toBe(3);
  });

  it("sends the statement keyed by CIF with an empty client_id", () => {
    const body = ENDPOINTS.statement.build!({ cif: "38909947" });
    const search = JSON.parse(body.sSearch) as Record<string, unknown>;
    expect(search.fisa_client_cif).toBe("38909947");
    expect(search.client_id).toBe("");
    expect(search.fisa_client).toBe(true);
  });

  it("uses plain form fields (not sSearch JSON) for client details", () => {
    const body = ENDPOINTS.clientDetails.build!({ client: "DRUID S.A.", cif: "38909947" });
    expect(body).toEqual({ client_name: "DRUID S.A.", client_cif: "38909947" });
  });
});

describe("portal login", () => {
  const loginPage = () =>
    res(200, {
      body: '<input type="hidden" name="csrfmiddlewaretoken" value="MW123">',
      setCookie: ["csrftoken=csrf1; Path=/"],
    });
  /** What /auth/login/ajax/ answers, shaped from a real capture. */
  const ajax = (body: Record<string, unknown>, setCookie?: string[]) =>
    res(200, { body: JSON.stringify(body), ...(setCookie ? { setCookie } : {}) });

  it("posts the ajax endpoint, follows the login-key hop and returns the cookies", async () => {
    const seen: string[] = [];
    const fetchImpl = scriptedFetch([
      (url) => { seen.push(url); return loginPage(); },
      // The browser's endpoint: a JSON verdict plus the hop that completes the session.
      (url) => { seen.push(url); return ajax(
        { successfully: true, errorText: "", force_redirect: true,
          url: "/auth/login-key/abc/?srvid=3&next=/", security_code: null },
        ["srvid=3; Path=/"]); },
      (url) => { seen.push(url); return res(302, { location: "/", setCookie: ["sessionid=sess1; Path=/"] }); },
      (url) => { seen.push(url); return res(200, { body: "<html>dashboard</html>" }); },
    ]);

    const jar = await login("me@example.com", "pw", fetchImpl);
    expect(seen[1]).toContain("/auth/login/ajax/");
    expect(seen[2]).toContain("/auth/login-key/abc/");
    expect(jar).toMatchObject({ csrftoken: "csrf1", srvid: "3", sessionid: "sess1" });
    expect(cookieHeader(jar)).toContain("sessionid=sess1");
  });

  // The stage is what decides whether someone is told their password was wrong,
  // so each failure has to carry the right one. Only SmartBill actually refusing
  // is a credentials problem; the rest are sign-ins that got further than that.
  it("carries SmartBill's own refusal text rather than a guess at the reason", async () => {
    const errorText = "Datele de autentificare sunt incorecte. Te rugam reincearca.";
    const fetchImpl = scriptedFetch([loginPage, () => ajax({ successfully: false, errorText })]);
    await expect(login("me@example.com", "bad", fetchImpl))
      .rejects.toMatchObject({ stage: "credentials", portalText: errorText });
  });

  it("does not invent a reason when SmartBill refuses without giving one", async () => {
    const fetchImpl = scriptedFetch([loginPage, () => ajax({ successfully: false, errorText: "" })]);
    await expect(login("me@example.com", "bad", fetchImpl))
      .rejects.toMatchObject({ stage: "credentials", portalText: undefined });
  });

  it("tags an unreadable login page as login-page, not a bad password", async () => {
    // No csrfmiddlewaretoken and no csrftoken cookie: the page is not what we expect.
    const fetchImpl = scriptedFetch([() => res(200, { body: "<html>maintenance</html>" })]);
    await expect(login("me@example.com", "pw", fetchImpl))
      .rejects.toMatchObject({ stage: "login-page" });
  });

  it("tags a non-JSON login response as login-page, not a bad password", async () => {
    // The endpoint moved, or something in front of it answered instead.
    const fetchImpl = scriptedFetch([loginPage, () => res(502, { body: "<html>bad gateway</html>" })]);
    await expect(login("me@example.com", "pw", fetchImpl))
      .rejects.toMatchObject({ stage: "login-page" });
  });

  it("tags a sign-in that sets no session cookie as no-session", async () => {
    const fetchImpl = scriptedFetch([
      loginPage,
      () => ajax({ successfully: true, url: "/", security_code: null }),
      () => res(200, { body: "<html>ok</html>" }), // no session cookie anywhere
    ]);
    await expect(login("me@example.com", "pw", fetchImpl))
      .rejects.toMatchObject({ stage: "no-session" });
  });

  it("blames a device confirmation code only when the sign-in produced no session", async () => {
    // security_code is inference from one observation, so it must never be able to
    // fail a sign-in that otherwise worked — it only sharpens the explanation.
    const stepUp = scriptedFetch([
      loginPage,
      () => ajax({ successfully: true, url: "/", security_code: "sent" }),
      () => res(200, { body: "<html>enter the code</html>" }),
    ]);
    await expect(login("me@example.com", "pw", stepUp))
      .rejects.toMatchObject({ stage: "security-code" });

    const worked = scriptedFetch([
      loginPage,
      () => ajax({ successfully: true, url: "/", security_code: "sent" },
        ["sessionid=sess9; Path=/"]),
      () => res(200, { body: "<html>dashboard</html>" }),
    ]);
    await expect(worked ? login("me@example.com", "pw", worked) : null)
      .resolves.toMatchObject({ sessionid: "sess9" });
  });
});

describe("scrapeApiCredentials", () => {
  it("extracts user, token and cif from the integrations page", async () => {
    const html = [
      "'User-ul meu este body@genez.io%0D%0A',",
      "'Token-ul este 003|8efc470a6eb1a2808f61ca3bcf24905e%0D%0A',",
      "'CIF-ul firmei este RO48481960.%0D%0A',",
    ].join("\n");
    const fetchImpl = scriptedFetch([() => res(200, { body: html })]);
    const creds = await scrapeApiCredentials({ csrftoken: "c", sessionid: "s" }, fetchImpl);
    expect(creds).toEqual({ user: "body@genez.io", token: "003|8efc470a6eb1a2808f61ca3bcf24905e", cif: "RO48481960" });
  });

  it("tags a non-200 integrations page as integrations, not a bad password", async () => {
    const fetchImpl = scriptedFetch([() => res(500, { body: "boom" })]);
    await expect(scrapeApiCredentials({ csrftoken: "c", sessionid: "s" }, fetchImpl))
      .rejects.toMatchObject({ stage: "integrations" });
  });

  // SmartBill rebuilt the page: the Romanian mailto blob the original patterns
  // read is gone, and every new sign-up failed the scrape — reported as a wrong
  // password. Shape taken from the live page.
  it("reads the current page, where the values live in a JS config object", async () => {
    const html = [
      'subscriptionPackageName: "Platinum", subscriptionIsExpired: false,',
      'userEmail: "body@genez.io", userKey: "003|8efc470a6eb1a2808f61ca3bcf24905e",',
      'properCif: "RO48481960", companyCif: "RO48481960",',
    ].join("\n");
    const fetchImpl = scriptedFetch([() => res(200, { body: html })]);
    const creds = await scrapeApiCredentials({ csrftoken: "c", sessionid: "s" }, fetchImpl);
    expect(creds).toEqual({
      user: "body@genez.io",
      token: "003|8efc470a6eb1a2808f61ca3bcf24905e",
      cif: "RO48481960",
    });
  });

  // The real page, as served today. The Romanian labels are still present but the
  // mailto href percent-encodes them, so "Token-ul este" with a literal space
  // matches nothing — the text is there and simply unreadable to the old regex.
  it("reads the live page: JS config, visible markup, and the encoded mailto", async () => {
    const html = [
      '<span class="token_key">003|8efc470a6eb1a2808f61ca3bcf24905e</span>',
      '<a href="mailto:?subject=x&body=Salut%2C%0D%0A',
      'User-ul%20meu%20este%20body%40genez.io%0D%0A',
      'Token-ul%20este%20003%7C8efc470a6eb1a2808f61ca3bcf24905e%0D%0A',
      'CIF-ul%20firmei%20este%20RO48481960.%0D%0A">aici</a>',
    ].join("");
    const fetchImpl = scriptedFetch([() => res(200, { body: html })]);
    const creds = await scrapeApiCredentials({ csrftoken: "c", sessionid: "s" }, fetchImpl);
    expect(creds.token).toBe("003|8efc470a6eb1a2808f61ca3bcf24905e");
    expect(creds.cif).toBe("RO48481960");
    expect(creds.user).toBe("body@genez.io");
  });

  // With no JS config and no visible span, the encoded mailto alone must carry it.
  it("recovers the credentials from the encoded mailto blob alone", async () => {
    const html =
      "body=Salut%2C%0D%0AUser-ul%20meu%20este%20body%40genez.io%0D%0A" +
      "Token-ul%20este%20003%7C8efc470a6eb1a2808f61ca3bcf24905e%0D%0A" +
      "CIF-ul%20firmei%20este%20RO48481960.%0D%0A";
    const fetchImpl = scriptedFetch([() => res(200, { body: html })]);
    const creds = await scrapeApiCredentials({ csrftoken: "c", sessionid: "s" }, fetchImpl);
    expect(creds.token).toBe("003|8efc470a6eb1a2808f61ca3bcf24905e");
    expect(creds.cif).toBe("RO48481960");
    expect(creds.user).toBe("body@genez.io");
  });

  // If the labels change language entirely, the token's own shape still carries.
  it("falls back to the token's shape when every label is unrecognisable", async () => {
    const html = 'window.cfg = { someKey: "x" }; the token is 003|8efc470a6eb1a2808f61ca3bcf24905e here';
    const fetchImpl = scriptedFetch([() => res(200, { body: html })]);
    const creds = await scrapeApiCredentials({ csrftoken: "c", sessionid: "s" }, fetchImpl);
    expect(creds.token).toBe("003|8efc470a6eb1a2808f61ca3bcf24905e");
  });

  it("still reads the old page shape, so an account served it keeps working", async () => {
    const html = [
      "'User-ul meu este old@genez.io%0D%0A',",
      "'Token-ul este 003|old470a6eb1a2808f61ca3bcf24905e%0D%0A',",
      "'CIF-ul firmei este RO12345678.%0D%0A',",
    ].join("\n");
    const fetchImpl = scriptedFetch([() => res(200, { body: html })]);
    const creds = await scrapeApiCredentials({ csrftoken: "c", sessionid: "s" }, fetchImpl);
    expect(creds.token).toBe("003|old470a6eb1a2808f61ca3bcf24905e");
    expect(creds.cif).toBe("RO12345678");
  });
});

describe("sign-in failure messages", () => {
  const message = (stage: PortalAuthStage) =>
    authFailureMessage(new PortalAuthError("internal detail", stage));

  it("blames the password only when the password was actually rejected", () => {
    expect(message("credentials")).toMatch(/did not accept that email and password/i);
    for (const stage of ["login-page", "no-session", "integrations", "no-api-token"] as const) {
      expect(message(stage)).not.toMatch(/did not accept that email and password/i);
    }
  });

  it("points a user with no API token at the page that proves it", () => {
    // The whole reason this stage exists: signing in works, the account is fine,
    // and the only thing missing is API access on that SmartBill user.
    expect(message("no-api-token")).toMatch(/integrari/);
    expect(message("no-api-token")).toMatch(/API access/i);
  });

  it("never leaks the internal detail to the page", () => {
    for (const stage of
      ["credentials", "login-page", "no-session", "integrations", "no-api-token"] as const) {
      expect(message(stage)).not.toContain("internal detail");
    }
  });
});

describe("request + isUnauthenticated", () => {
  it("posts the built body and reports a healthy JSON response as authenticated", async () => {
    let sentBody = "";
    const fetchImpl = scriptedFetch([
      (_url, init) => {
        sentBody = String(init?.body ?? "");
        return res(200, { body: JSON.stringify({ successfully: true, clients: [] }) });
      },
    ]);
    const jar: PortalCookies = { csrftoken: "c", sessionid: "s" };
    const out = await request(jar, ENDPOINTS.balances, { cif: "38909947" }, fetchImpl);
    expect(out.status).toBe(200);
    expect(sentBody).toContain("sSearch=");
    expect(isUnauthenticated(out)).toBe(false);
  });

  it("treats a csrf_fails sentinel and an /auth/ redirect as unauthenticated", () => {
    expect(isUnauthenticated({ status: 200, location: "", text: '{"csrf_fails": true}' })).toBe(true);
    expect(isUnauthenticated({ status: 302, location: "/auth/login/?next=/x", text: "" })).toBe(true);
    expect(isUnauthenticated({ status: 200, location: "", text: '{"successfully": true}' })).toBe(false);
  });
});
