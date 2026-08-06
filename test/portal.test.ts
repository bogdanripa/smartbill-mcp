import { beforeEach, describe, expect, it } from "vitest";
import { PortalNeedsManualError, PortalService } from "../src/portal/service.js";
import { mergeReceivablePages } from "../src/portal/tools.js";
import { PortalAuthError } from "../src/portal/session.js";
import { InMemoryTenantStore } from "../src/store/tenants.js";

const EMAIL = "user@example.com";
const PASSWORD = "hunter2";
const TOKEN = "003|abc123";
const CIF = "RO12345678";

/**
 * A stand-in for the SmartBill Cloud portal. It answers the multi-hop login,
 * the integrations scrape, and report POSTs, and lets a test steer whether
 * login succeeds and what each report call returns — so the service's session
 * reuse, re-login and failure-breaker logic can be exercised without a network.
 */
interface FakePortal {
  fetchImpl: typeof fetch;
  loginSucceeds: boolean;
  /** Queued responses for report POSTs; each call consumes one (default: 200 ok). */
  reportQueue: Array<() => Response>;
}

function makeResponse(status: number, body: string | null, headers: Record<string, string | string[]> = {}): Response {
  const h = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "set-cookie") {
      for (const cookie of Array.isArray(value) ? value : [value]) h.append("set-cookie", cookie);
    } else {
      h.set(key, value as string);
    }
  }
  return new Response(body, { status, headers: h });
}

function makeFakePortal(): FakePortal {
  const portal: FakePortal = { loginSucceeds: true, reportQueue: [], fetchImpl: async () => new Response() };
  let loginCount = 0;

  portal.fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;

    if (path === "/auth/login/" && method === "GET") {
      return makeResponse(200, '<input name="csrfmiddlewaretoken" value="csrf-abc">', {
        "set-cookie": "csrftoken=tok123; Path=/",
      });
    }
    if (path === "/auth/login/" && method === "POST") {
      loginCount += 1;
      if (!portal.loginSucceeds) return makeResponse(302, null, { location: "/auth/login/" });
      return makeResponse(302, null, { location: "/", "set-cookie": `sessionid=sess-${loginCount}; Path=/` });
    }
    if (path === "/" && method === "GET") {
      return makeResponse(200, "ok");
    }
    if (path === "/core/integrari/" && method === "GET") {
      return makeResponse(
        200,
        `User-ul meu este ${EMAIL}%0D Token-ul este ${TOKEN}%0D CIF-ul firmei este ${CIF}`,
      );
    }
    if (method === "POST") {
      const next = portal.reportQueue.shift();
      return next ? next() : makeResponse(200, JSON.stringify({ ok: true }));
    }
    return makeResponse(404, "not found");
  };

  return portal;
}

describe("PortalService", () => {
  let portal: FakePortal;
  let store: InMemoryTenantStore;
  let service: PortalService;

  beforeEach(() => {
    portal = makeFakePortal();
    store = new InMemoryTenantStore();
    service = new PortalService(store, portal.fetchImpl);
  });

  it("onboards: logs in, scrapes the token/CIF, and stores the tenant", async () => {
    const result = await service.onboard(EMAIL, PASSWORD);

    expect(result).toEqual({ token: TOKEN, cif: CIF });
    const tenant = await store.get(EMAIL);
    expect(tenant?.token).toBe(TOKEN);
    expect(tenant?.cif).toBe(CIF);
    expect(tenant?.password).toBe(PASSWORD);
    expect(tenant?.cookies.sessionid).toBeDefined();
    expect(tenant?.needsManual).toBe(false);
  });

  it("runs a report on the stored session and returns parsed JSON", async () => {
    await service.onboard(EMAIL, PASSWORD);
    portal.reportQueue.push(() => makeResponse(200, JSON.stringify({ rows: [1, 2, 3] })));

    const data = await service.call(EMAIL, TOKEN, CIF, "clients", {});

    expect(data).toEqual({ rows: [1, 2, 3] });
  });

  it("re-logs in once when the stored session has expired, then retries", async () => {
    await service.onboard(EMAIL, PASSWORD);
    portal.reportQueue.push(() => makeResponse(401, "")); // stored session rejected
    portal.reportQueue.push(() => makeResponse(200, JSON.stringify({ ok: 1 }))); // after re-login

    const data = await service.call(EMAIL, TOKEN, CIF, "clients", {});

    expect(data).toEqual({ ok: 1 });
    const tenant = await store.get(EMAIL);
    expect(tenant?.failCount).toBe(0);
  });

  it("rejects a connector URL whose token or CIF does not match the stored tenant", async () => {
    await service.onboard(EMAIL, PASSWORD);

    await expect(service.call(EMAIL, "WRONG-TOKEN", CIF, "clients", {})).rejects.toBeInstanceOf(PortalAuthError);
    await expect(service.call(EMAIL, TOKEN, "RO999", "clients", {})).rejects.toBeInstanceOf(PortalAuthError);
  });

  it("trips the manual-intervention breaker after repeated re-login failures", async () => {
    await service.onboard(EMAIL, PASSWORD);
    portal.loginSucceeds = false;

    // Each call: stored session rejected, then re-login fails → failure counter climbs.
    portal.reportQueue.push(() => makeResponse(401, ""));
    await expect(service.call(EMAIL, TOKEN, CIF, "clients", {})).rejects.toBeInstanceOf(PortalAuthError);

    portal.reportQueue.push(() => makeResponse(401, ""));
    await expect(service.call(EMAIL, TOKEN, CIF, "clients", {})).rejects.toBeInstanceOf(PortalAuthError);

    // Third failure crosses the threshold and freezes the account.
    portal.reportQueue.push(() => makeResponse(401, ""));
    await expect(service.call(EMAIL, TOKEN, CIF, "clients", {})).rejects.toBeInstanceOf(PortalNeedsManualError);

    const tenant = await store.get(EMAIL);
    expect(tenant?.failCount).toBe(3);
    expect(tenant?.needsManual).toBe(true);

    // Once frozen, further calls short-circuit without touching the network.
    await expect(service.call(EMAIL, TOKEN, CIF, "clients", {})).rejects.toBeInstanceOf(PortalNeedsManualError);
  });

  it("directs an un-onboarded account to the setup page", async () => {
    await expect(service.call("stranger@example.com", TOKEN, CIF, "clients", {})).rejects.toBeInstanceOf(
      PortalNeedsManualError,
    );
  });

  it("re-onboarding resets a frozen account", async () => {
    await service.onboard(EMAIL, PASSWORD);
    await store.patch(EMAIL, { failCount: 3, needsManual: true });

    await service.onboard(EMAIL, PASSWORD);

    const tenant = await store.get(EMAIL);
    expect(tenant?.failCount).toBe(0);
    expect(tenant?.needsManual).toBe(false);
  });
});

describe("receivables pagination", () => {
  /** Pages of `size` client rows each, totalling `total`, labelled by index. */
  const pager = (total: number, calls: number[] = []) =>
    (page: number, size: number) => {
      calls.push(page);
      const start = (page - 1) * size;
      return Promise.resolve({
        clientsCount: total,
        currencies: ["RON"],
        clients: Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, i) => ({
          info: { id: start + i },
        })),
      });
    };

  it("walks every page and merges them into one payload", async () => {
    const calls: number[] = [];
    const merged = await mergeReceivablePages(pager(16, calls), 10);
    expect(calls).toEqual([1, 2]);
    expect(merged.clients).toHaveLength(16);
    expect((merged.clients as Array<{ info: { id: number } }>).map((c) => c.info.id)).toEqual(
      Array.from({ length: 16 }, (_, i) => i),
    );
    // Top-level fields come from the first page and survive the merge.
    expect(merged.clientsCount).toBe(16);
    expect(merged.currencies).toEqual(["RON"]);
    expect(merged.truncated).toBeUndefined();
  });

  it("stops on a short page without asking for one more", async () => {
    const calls: number[] = [];
    const merged = await mergeReceivablePages(pager(7, calls), 10);
    expect(calls).toEqual([1]);
    expect(merged.clients).toHaveLength(7);
  });

  it("keeps going when the row count runs past clientsCount", async () => {
    // A client billed in two currencies gets a row per currency, so rows can
    // exceed clientsCount. Stopping at clientsCount would drop the tail.
    const calls: number[] = [];
    const fetchPage = (page: number, size: number) => {
      calls.push(page);
      const rows = page === 1 ? size : 3;
      return Promise.resolve({
        clientsCount: 5, // deliberately lower than the rows returned
        clients: Array.from({ length: rows }, (_, i) => ({ info: { id: (page - 1) * size + i } })),
      });
    };
    const merged = await mergeReceivablePages(fetchPage, 10);
    expect(calls).toEqual([1, 2]);
    expect(merged.clients).toHaveLength(13);
  });

  it("flags truncation instead of silently returning a short list", async () => {
    // Every page comes back full, so the walk hits its ceiling with more to go.
    const merged = await mergeReceivablePages(pager(1000), 10, 3);
    expect(merged.clients).toHaveLength(30);
    expect(merged.truncated).toBe(true);
    expect(merged.truncationNote).toMatch(/narrow the report/i);
  });
});
