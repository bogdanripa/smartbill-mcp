import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildConfig, type Credentials, type SmartBillConfig } from "./config.js";
import { CredentialError, decodeBasicAuth, decodeCredentials } from "./credentials.js";
import { createServer } from "./server.js";

export interface HttpOptions {
  port: number;
  host: string;
  /** Base path the MCP endpoint is mounted at. Credentials follow it as one segment. */
  path: string;
  /** Host header values accepted, for DNS rebinding protection. Empty disables the check. */
  allowedHosts: string[];
}

export function loadHttpOptions(env: NodeJS.ProcessEnv = process.env): HttpOptions {
  const port = Number(env.PORT ?? 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got ${env.PORT}`);
  }

  const path = env.MCP_PATH?.trim() || "/mcp";
  if (!path.startsWith("/")) {
    throw new Error(`MCP_PATH must start with a slash, got ${path}`);
  }

  return {
    port,
    host: env.HOST?.trim() || "0.0.0.0",
    path: path.endsWith("/") ? path.slice(0, -1) : path,
    allowedHosts:
      env.MCP_ALLOWED_HOSTS?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? [],
  };
}

/**
 * Runs the MCP server over streamable HTTP, multi-tenant and stateless.
 *
 * Each request carries its own SmartBill credentials, either as a base64url
 * segment on the URL (`/mcp/<credentials>`) or as an `Authorization: Basic`
 * header with `X-SmartBill-Cif`. Nothing is shared between requests, so one
 * deployment can serve any number of accounts.
 */
export function createHttpTransport(
  options: HttpOptions,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): Server {
  return createHttpServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      // Deliberately does not log the URL: it carries the caller's credentials.
      console.error("smartbill-mcp request failed:", error instanceof Error ? error.message : error);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (!isMcpPath(url.pathname, options.path)) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    let config: SmartBillConfig;
    try {
      config = buildConfig(resolveCredentials(req, url, options.path), { defaultPdfDelivery: "base64" }, env);
    } catch (error) {
      if (!(error instanceof CredentialError)) throw error;
      res.setHeader("WWW-Authenticate", 'Basic realm="smartbill-mcp"');
      sendJson(res, 401, { error: "unauthorized", message: error.message });
      return;
    }

    const server = createServer(config, fetchImpl);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: options.allowedHosts.length > 0,
      allowedHosts: options.allowedHosts.length > 0 ? options.allowedHosts : undefined,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
  }
}

function isMcpPath(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * Credentials come from the URL segment when present, otherwise from the
 * Authorization header. The header form keeps the token out of access logs, so
 * it wins when both are supplied.
 */
function resolveCredentials(req: IncomingMessage, url: URL, base: string): Credentials {
  const series = {
    defaultInvoiceSeries: url.searchParams.get("invoiceSeries")?.trim() || undefined,
    defaultEstimateSeries: url.searchParams.get("estimateSeries")?.trim() || undefined,
    defaultReceiptSeries: url.searchParams.get("receiptSeries")?.trim() || undefined,
  };

  const header = req.headers.authorization;
  if (header) {
    const { username, token } = decodeBasicAuth(header);
    const companyVatCode = headerValue(req, "x-smartbill-cif");
    if (!companyVatCode) {
      throw new CredentialError(
        "When authenticating with an Authorization header, send the company VAT code in X-SmartBill-Cif.",
      );
    }
    return { username, token, companyVatCode, ...series };
  }

  const segment = url.pathname.slice(base.length).replace(/^\/+/, "").split("/")[0];
  if (!segment) {
    throw new CredentialError(
      `No SmartBill credentials supplied. Use ${base}/<credentials>, or send an Authorization: Basic ` +
        "header together with X-SmartBill-Cif.",
    );
  }

  return { ...decodeCredentials(segment), ...series };
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}
