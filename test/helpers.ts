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
