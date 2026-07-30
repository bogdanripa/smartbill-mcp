import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildConfig, type SmartBillConfig } from "./config.js";
import { sendHtml, sendJson } from "./http-helpers.js";
import { renderHomePage } from "./landing.js";
import { OAuthError } from "./oauth/provider.js";
import { handleOAuthRequest } from "./oauth/routes.js";
import type { HostedRuntime } from "./portal/setup.js";
import { BUILD_SHA, createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

export interface HttpOptions {
  port: number;
  host: string;
  /** Base path the MCP endpoint is mounted at. */
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
 * Authentication is OAuth 2.1: a client adds the bare connector URL, is sent
 * through the authorization flow (where it signs into SmartBill), and then
 * calls the MCP endpoint with `Authorization: Bearer <access token>`. The
 * bearer token maps to a stored tenant, so no SmartBill secret ever travels in
 * the URL. Requires the hosted runtime (DATABASE_URL + SMARTBILL_SESSION_KEY);
 * without it there is no way to authenticate and MCP requests are refused.
 */
export function createHttpTransport(
  options: HttpOptions,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
  runtime?: HostedRuntime,
): Server {
  return createHttpServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      // Deliberately does not log the URL: it may carry a bearer token.
      console.error("smartbill-mcp request failed:", error instanceof Error ? error.message : error);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const base = publicBaseUrl(req);
    const url = new URL(req.url ?? "/", base);

    if (url.pathname === "/health") {
      sendJson(res, 200, { status: "ok", version: SERVER_VERSION, commit: BUILD_SHA });
      return;
    }

    // OAuth authorization-server + discovery endpoints.
    if (
      runtime &&
      (await handleOAuthRequest(req, res, url, { provider: runtime.oauth, baseUrl: base, mcpPath: options.path }))
    ) {
      return;
    }

    // Browsers get the marketing homepage; everything else gets JSON.
    if (url.pathname === "/") {
      if (wantsHtml(req)) {
        sendHtml(res, 200, renderHomePage(`${base}${options.path}`));
      } else {
        sendJson(res, 200, {
          name: SERVER_NAME,
          version: SERVER_VERSION,
          commit: BUILD_SHA,
          status: "ok",
          transport: "streamable-http",
          endpoint: options.path,
          authorization: "oauth2",
          documentation: "https://github.com/bogdanripa/smartbill-mcp#running-over-http-multi-tenant",
        });
      }
      return;
    }

    if (!isMcpPath(url.pathname, options.path)) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    if (!runtime) {
      sendJson(res, 503, {
        error: "oauth_unavailable",
        message: "This deployment is not configured for OAuth (missing DATABASE_URL / SMARTBILL_SESSION_KEY).",
      });
      return;
    }

    // Bearer auth. On any failure, point the client at our resource metadata so
    // it can start (or restart) the OAuth flow.
    const credentials = await resolveBearer(req, runtime);
    if (!credentials) {
      const metadataUrl = `${base}/.well-known/oauth-protected-resource${options.path}`;
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}"`);
      sendJson(res, 401, { error: "invalid_token", message: "A valid OAuth bearer token is required." });
      return;
    }

    const config = buildConfig(credentials, { defaultPdfDelivery: "text" }, env);
    const server = createServer(config, { fetchImpl, portal: runtime.portal });
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

/** Resolves the SmartBill credentials behind an `Authorization: Bearer` token, or null. */
async function resolveBearer(
  req: IncomingMessage,
  runtime: HostedRuntime,
): Promise<{ username: string; token: string; companyVatCode: string } | null> {
  const header = req.headers.authorization;
  const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  if (!match?.[1]) return null;
  try {
    return await runtime.oauth.verifyBearer(match[1].trim());
  } catch (error) {
    if (error instanceof OAuthError) return null;
    throw error;
  }
}

/** The public origin the request arrived on, honouring the reverse proxy in front. */
function publicBaseUrl(req: IncomingMessage): string {
  const forwardedProto = headerValue(req, "x-forwarded-proto")?.split(",")[0]?.trim();
  const host = headerValue(req, "x-forwarded-host") ?? headerValue(req, "host") ?? "localhost";
  const isLocal = /^(localhost|127\.\d|\[?::1\]?)/.test(host);
  const scheme = forwardedProto ?? (isLocal ? "http" : "https");
  return `${scheme}://${host}`;
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
