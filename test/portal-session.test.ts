import { describe, expect, it } from "vitest";
import { ENDPOINTS } from "../src/portal/endpoints.js";
import {
  cookieHeader,
  isUnauthenticated,
  login,
  PortalAuthError,
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
  it("follows the login-key redirect chain and returns the session cookies", async () => {
    const fetchImpl = scriptedFetch([
      // 1. GET login page → csrftoken + middleware token
      () =>
        res(200, {
          body: '<input type="hidden" name="csrfmiddlewaretoken" value="MW123">',
          setCookie: ["csrftoken=csrf1; Path=/"],
        }),
      // 2. POST credentials → 302 to login-key
      () => res(302, { location: "/auth/login-key/abc/?srvid=3&next=/", setCookie: ["srvid=3; Path=/"] }),
      // 3. GET login-key → 302 to / , sets sessionid
      () => res(302, { location: "/", setCookie: ["sessionid=sess1; Path=/"] }),
      // 4. GET / → 200
      () => res(200, { body: "<html>dashboard</html>" }),
    ]);

    const jar = await login("me@example.com", "pw", fetchImpl);
    expect(jar).toMatchObject({ csrftoken: "csrf1", srvid: "3", sessionid: "sess1" });
    expect(cookieHeader(jar)).toContain("sessionid=sess1");
  });

  it("throws PortalAuthError when the flow bounces back to the login form", async () => {
    const fetchImpl = scriptedFetch([
      () => res(200, { body: '<input name="csrfmiddlewaretoken" value="MW">', setCookie: ["csrftoken=c; Path=/"] }),
      () => res(302, { location: "/auth/login/?next=/" }), // straight back to the form = rejected
    ]);
    await expect(login("me@example.com", "bad", fetchImpl)).rejects.toBeInstanceOf(PortalAuthError);
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
