import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildConfig, type Credentials, type SmartBillConfig } from "./config.js";
import { CredentialError, decodeBasicAuth, decodeCredentials, encodeCredentials } from "./credentials.js";
import { renderLandingPage } from "./landing.js";
import type { PortalService } from "./portal/service.js";
import { PortalAuthError } from "./portal/session.js";
import { BUILD_SHA, createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

export interface HttpOptions {
  port: number;
  host: string;
  /** Base path the MCP endpoint is mounted at. Credentials follow it as one segment. */
  path: string;
  /** Host header values accepted, for DNS rebinding protection. Empty disables the check. */
  allowedHosts: string[];
}

/**
 * Binding '::' accepts IPv4 and IPv6 alike. Binding '0.0.0.0' does not: a
 * healthcheck that asks for `localhost` resolves ::1 first and is refused, which
 * is enough for an orchestrator to declare a perfectly healthy container dead.
 */
const DUAL_STACK = "::";

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
    host: env.HOST?.trim() || DUAL_STACK,
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
  portal?: PortalService,
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
      sendJson(res, 200, { status: "ok", version: SERVER_VERSION, commit: BUILD_SHA });
      return;
    }

    // Onboarding: the setup page posts { email, password }; we log into SmartBill,
    // scrape the scoped API token + CIF, store the tenant, and return the MCP URL.
    if (url.pathname === "/setup" && req.method === "POST") {
      await handleSetup(req, res, options.path, portal);
      return;
    }

    // A browser gets the setup page that builds a connector URL; anything else
    // — health checks, curl, monitoring — keeps getting JSON.
    if (url.pathname === "/") {
      if (wantsHtml(req)) {
        sendHtml(res, 200, renderLandingPage(options.path));
      } else {
        sendJson(res, 200, {
          name: SERVER_NAME,
          version: SERVER_VERSION,
          commit: BUILD_SHA,
          status: "ok",
          transport: "streamable-http",
          endpoint: `${options.path}/<credentials>`,
          setup: "Open this URL in a browser to generate your connector URL.",
          documentation: "https://github.com/bogdanripa/smartbill-mcp#running-over-http-multi-tenant",
        });
      }
      return;
    }

    if (!isMcpPath(url.pathname, options.path)) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    let config: SmartBillConfig;
    try {
      config = buildConfig(resolveCredentials(req, url, options.path), { defaultPdfDelivery: "text" }, env);
    } catch (error) {
      if (!(error instanceof CredentialError)) throw error;
      res.setHeader("WWW-Authenticate", 'Basic realm="smartbill-mcp"');
      sendJson(res, 401, { error: "unauthorized", message: error.message });
      return;
    }

    const server = createServer(config, { fetchImpl, portal });
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

/** Reads a request body, capped so a huge POST can't exhaust memory. */
async function readBody(req: IncomingMessage, limitBytes = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limitBytes) throw new CredentialError("Request body too large.");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Onboarding endpoint. Takes { email, password } as JSON, logs into SmartBill,
 * stores the tenant, and returns { url } — the connector URL to paste into an
 * MCP client. The password is used here and stored (encrypted) for auto-relogin;
 * it is never logged.
 */
async function handleSetup(
  req: IncomingMessage,
  res: ServerResponse,
  mountPath: string,
  portal: PortalService | undefined,
): Promise<void> {
  if (!portal) {
    sendJson(res, 503, { error: "setup_unavailable", message: "Portal onboarding is not configured on this server." });
    return;
  }

  let email: string;
  let password: string;
  try {
    const parsed = JSON.parse(await readBody(req)) as { email?: unknown; password?: unknown };
    email = typeof parsed.email === "string" ? parsed.email.trim() : "";
    password = typeof parsed.password === "string" ? parsed.password : "";
    if (!email || !password) throw new Error("missing");
  } catch {
    sendJson(res, 400, { error: "bad_request", message: "Send JSON with a non-empty email and password." });
    return;
  }

  try {
    const { token, cif } = await portal.onboard(email, password);
    const segment = encodeCredentials({ username: email, token, companyVatCode: cif });
    sendJson(res, 200, { url: `${mountPath}/${segment}` });
  } catch (error) {
    if (error instanceof PortalAuthError) {
      sendJson(res, 401, { error: "login_failed", message: error.message });
      return;
    }
    // Never surface internals (or the password) — log a generic message.
    console.error("smartbill-mcp setup failed:", error instanceof Error ? error.message : error);
    sendJson(res, 502, { error: "setup_failed", message: "Could not complete SmartBill sign-in. Try again." });
  }
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

/**
 * Starts listening, turning the two failures that actually happen in a container
 * into messages that say what to do. Without this a listen error leaves the
 * start-up promise pending forever and surfaces as an unhandled 'error' event.
 */
export function listen(server: Server, options: HttpOptions): Promise<void> {
  return bind(server, options, options.host).catch((error: NodeJS.ErrnoException) => {
    // A host with IPv6 disabled cannot bind '::'. Fall back to IPv4-only rather
    // than refusing to start.
    if (options.host === DUAL_STACK && (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL")) {
      return bind(server, options, "0.0.0.0");
    }
    throw error;
  });
}

function bind(server: Server, options: HttpOptions, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EACCES" && options.port < 1024) {
        reject(
          new Error(
            `Not allowed to bind port ${options.port}. Ports below 1024 need root or ` +
              `CAP_NET_BIND_SERVICE — run the container as root, or set PORT to something above 1024.`,
          ),
        );
      } else if (error.code === "EADDRINUSE") {
        reject(new Error(`Port ${options.port} is already in use on ${host}.`));
      } else {
        reject(error);
      }
    };

    server.once("error", onError);
    server.listen(options.port, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

/** True when the caller is a browser rather than a health check or an API client. */
function wantsHtml(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    // The page holds credentials in the DOM while the user is on it.
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}
