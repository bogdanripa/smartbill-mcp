import { loadConfig, type SmartBillConfig } from "../src/config.js";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface StubResponse {
  status?: number;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
}

/** A fetch stub that records calls and replays queued responses in order. */
export function stubFetch(responses: StubResponse[]) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];

  const impl: typeof fetch = async (input, init) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    const next = queue.shift() ?? { json: { errorText: "" } };
    const responseHeaders = new Headers(next.headers ?? {});
    let body: BodyInit | null = null;

    if (next.json !== undefined) {
      body = JSON.stringify(next.json);
      if (!responseHeaders.has("content-type")) responseHeaders.set("content-type", "application/json");
    } else if (next.body !== undefined) {
      body = next.body;
    }

    return new Response(body, { status: next.status ?? 200, headers: responseHeaders });
  };

  return { impl, calls };
}

export interface SmartBillStubOptions {
  /** API token the integrations page scrape yields (becomes the tenant's token). */
  apiToken?: string;
  /** CIF the integrations page scrape yields. */
  cif?: string;
  /** When false, the portal login bounces back to /auth/login/ (bad credentials). */
  loginSucceeds?: boolean;
  /** Response for public-API (ws.smartbill.ro) calls. Defaults to a success. */
  apiResponse?: () => Response;
}

function stubResponse(status: number, body: string | null, headers: Record<string, string | string[]> = {}): Response {
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

/**
 * A single fetch stub standing in for all of SmartBill: the Cloud portal
 * (multi-hop login + the integrations-page scrape that yields the API token/CIF)
 * and the public API (ws.smartbill.ro). Enough to drive onboarding and tool
 * calls end-to-end without a network.
 */
export function makeSmartBillStub(options: SmartBillStubOptions = {}) {
  const apiToken = options.apiToken ?? "003|scraped-token";
  const cif = options.cif ?? "RO12345678";
  const calls: RecordedCall[] = [];
  let loginCount = 0;

  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url: url.href,
      method,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const path = url.pathname;

    if (url.host === "cloud.smartbill.ro") {
      if (path === "/auth/login/" && method === "GET") {
        return stubResponse(200, '<input name="csrfmiddlewaretoken" value="csrf-x">', {
          "set-cookie": "csrftoken=tok; Path=/",
        });
      }
      if (path === "/auth/login/" && method === "POST") {
        loginCount += 1;
        if (options.loginSucceeds === false) return stubResponse(302, null, { location: "/auth/login/" });
        return stubResponse(302, null, { location: "/", "set-cookie": `sessionid=s${loginCount}; Path=/` });
      }
      if (path === "/" && method === "GET") return stubResponse(200, "ok");
      if (path === "/core/integrari/") {
        return stubResponse(200, `User-ul meu este u%0D Token-ul este ${apiToken}%0D CIF-ul firmei este ${cif}`);
      }
      return stubResponse(200, JSON.stringify({ ok: true }), { "content-type": "application/json" });
    }

    // Public API (ws.smartbill.ro/SBORO/api/...)
    return options.apiResponse
      ? options.apiResponse()
      : stubResponse(200, JSON.stringify({ errorText: "" }), { "content-type": "application/json" });
  };

  return { impl, calls, apiToken, cif };
}

export function testConfig(overrides: Partial<SmartBillConfig> = {}): SmartBillConfig {
  return {
    ...loadConfig({
      SMARTBILL_USERNAME: "user@example.com",
      SMARTBILL_TOKEN: "secret-token",
      SMARTBILL_VAT_CODE: "RO12345678",
      SMARTBILL_INVOICE_SERIES: "FF",
      SMARTBILL_ESTIMATE_SERIES: "PF",
      SMARTBILL_RECEIPT_SERIES: "CH",
    } as NodeJS.ProcessEnv),
    ...overrides,
  };
}
