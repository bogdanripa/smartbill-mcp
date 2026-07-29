import type { SmartBillConfig } from "./config.js";

export class SmartBillApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "SmartBillApiError";
  }
}

export interface BinaryResponse {
  bytes: Uint8Array;
  contentType: string;
  /** Filename suggested by the Content-Disposition header, when present. */
  filename?: string;
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Query;
  body?: unknown;
  accept?: string;
}

/**
 * SmartBill allows at most 3 calls per second. This spaces calls out so a burst
 * of tool invocations degrades into a queue instead of into 429s.
 */
const MIN_INTERVAL_MS = 1000 / 3;

export class SmartBillClient {
  private readonly authHeader: string;
  private queue: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;

  constructor(
    private readonly config: SmartBillConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    const credentials = Buffer.from(`${config.username}:${config.token}`).toString("base64");
    this.authHeader = `Basic ${credentials}`;
  }

  get companyVatCode(): string {
    return this.config.companyVatCode;
  }

  async requestJson<T = unknown>(options: Omit<RequestOptions, "accept">): Promise<T> {
    const response = await this.throttled(() => this.send({ ...options, accept: "application/json" }));
    const text = await response.text();
    const parsed = parseJson(text);

    if (!response.ok) {
      throw new SmartBillApiError(
        extractErrorMessage(parsed) ?? (text || response.statusText),
        response.status,
        parsed,
      );
    }

    // SmartBill signals business-level failures with HTTP 200 and a non-empty
    // `errorText` (or a non-zero `status.code` on the email endpoint).
    const businessError = extractErrorMessage(parsed);
    if (businessError) {
      throw new SmartBillApiError(businessError, response.status, parsed);
    }

    return parsed as T;
  }

  async requestBinary(options: Omit<RequestOptions, "accept" | "body">): Promise<BinaryResponse> {
    const response = await this.throttled(() =>
      this.send({ ...options, accept: "application/octet-stream" }),
    );
    const buffer = new Uint8Array(await response.arrayBuffer());

    if (!response.ok) {
      const text = Buffer.from(buffer).toString("utf8");
      const parsed = parseJson(text);
      throw new SmartBillApiError(
        extractErrorMessage(parsed) ?? (text || response.statusText),
        response.status,
        parsed,
      );
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    // An error can still come back as JSON under a 200, in which case there is no PDF.
    if (contentType.includes("application/json")) {
      const parsed = parseJson(Buffer.from(buffer).toString("utf8"));
      const businessError = extractErrorMessage(parsed);
      if (businessError) {
        throw new SmartBillApiError(businessError, response.status, parsed);
      }
    }

    return {
      bytes: buffer,
      contentType,
      filename: parseFilename(response.headers.get("content-disposition")),
    };
  }

  private async send(options: RequestOptions): Promise<Response> {
    const url = this.config.baseUrl + options.path + buildQuery(options.query);
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: options.accept ?? "application/json",
    };

    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      body = JSON.stringify(options.body);
    }

    try {
      return await this.fetchImpl(url, { method: options.method, headers, body });
    } catch (cause) {
      throw new SmartBillApiError(
        `Could not reach the SmartBill API at ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
        0,
      );
    }
  }

  /** Serialises calls and keeps them at or under 3 per second. */
  private throttled(run: () => Promise<Response>): Promise<Response> {
    const next = this.queue.then(async () => {
      const wait = this.lastCallAt + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastCallAt = Date.now();
      return run();
    });
    // Keep the chain alive even when a call rejects.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function buildQuery(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.append(key, String(value));
  }
  const serialised = params.toString();
  return serialised ? `?${serialised}` : "";
}

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Returns a human-readable error, or undefined when the payload reports success. */
function extractErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;

  if (typeof record.errorText === "string" && record.errorText.trim()) {
    return record.errorText.trim();
  }

  // POST /document/send answers with { status: { code, message } }.
  const status = record.status;
  if (status && typeof status === "object") {
    const { code, message } = status as Record<string, unknown>;
    if (code !== undefined && Number(code) !== 0 && Number(code) !== 200) {
      return typeof message === "string" && message.trim() ? message.trim() : `SmartBill returned status code ${code}`;
    }
  }

  return undefined;
}

function parseFilename(contentDisposition: string | null): string | undefined {
  if (!contentDisposition) return undefined;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(contentDisposition);
  const raw = match?.[1]?.trim();
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
