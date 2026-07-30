// Raw-node:http router for the OAuth authorization-server endpoints:
//   GET  /.well-known/oauth-authorization-server   (RFC 8414 metadata)
//   GET  /.well-known/oauth-protected-resource[/mcp](RFC 9728 metadata)
//   POST /register                                  (RFC 7591 DCR)
//   GET  /authorize                                 (sign-in page)
//   POST /authorize                                 (sign-in submit -> code)
//   POST /token                                     (code / refresh grants)
//   POST /revoke                                    (RFC 7009)
//
// handleOAuthRequest returns true once it has handled the request, so the main
// transport can fall through to the MCP endpoint otherwise.

import type { IncomingMessage, ServerResponse } from "node:http";
import { PortalAuthError } from "../portal/session.js";
import { CORS_HEADERS, readBody, sendHtml, sendJson } from "../http-helpers.js";
import { renderAuthorizePage } from "./page.js";
import { type AuthorizeRequest, OAuthError, type OAuthProvider } from "./provider.js";

export interface OAuthContext {
  provider: OAuthProvider;
  /** Absolute base URL of this deployment, no trailing slash (e.g. https://host). */
  baseUrl: string;
  /** MCP endpoint path, e.g. /mcp. */
  mcpPath: string;
}

function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: ["smartbill"],
  };
}

function protectedResourceMetadata(base: string, mcpPath: string) {
  return {
    resource: `${base}${mcpPath}`,
    authorization_servers: [base],
    resource_name: "smartbill-mcp",
    scopes_supported: ["smartbill"],
  };
}

function authorizeRequestFrom(get: (name: string) => string | undefined): AuthorizeRequest {
  return {
    clientId: get("client_id") ?? "",
    redirectUri: get("redirect_uri") ?? "",
    codeChallenge: get("code_challenge") ?? "",
    codeChallengeMethod: get("code_challenge_method") ?? "",
    responseType: get("response_type") ?? "",
    resource: get("resource"),
    scope: get("scope"),
  };
}

export async function handleOAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: OAuthContext,
): Promise<boolean> {
  const { provider, baseUrl, mcpPath } = ctx;
  const path = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();

  const isOAuthPath =
    path === "/.well-known/oauth-authorization-server" ||
    path === "/.well-known/oauth-protected-resource" ||
    path === `/.well-known/oauth-protected-resource${mcpPath}` ||
    path === "/register" ||
    path === "/authorize" ||
    path === "/token" ||
    path === "/revoke";
  if (!isOAuthPath) return false;

  if (method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return true;
  }

  if (path === "/.well-known/oauth-authorization-server" && method === "GET") {
    sendJson(res, 200, authorizationServerMetadata(baseUrl), CORS_HEADERS);
    return true;
  }
  if (
    (path === "/.well-known/oauth-protected-resource" || path === `/.well-known/oauth-protected-resource${mcpPath}`) &&
    method === "GET"
  ) {
    sendJson(res, 200, protectedResourceMetadata(baseUrl, mcpPath), CORS_HEADERS);
    return true;
  }

  if (path === "/register" && method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const info = await provider.registerClient(body);
      sendJson(res, 201, info, CORS_HEADERS);
    } catch (error) {
      sendOAuthError(res, error);
    }
    return true;
  }

  if (path === "/authorize" && method === "GET") {
    const request = authorizeRequestFrom((name) => url.searchParams.get(name) ?? undefined);
    try {
      const client = await provider.validateAuthorizeRequest(request);
      sendHtml(res, 200, renderAuthorizePage({ params: queryParams(url), clientName: client.clientName }));
    } catch (error) {
      // Never redirect for an invalid client/redirect_uri — show a plain error.
      sendHtml(res, 400, errorPage(error));
    }
    return true;
  }

  if (path === "/authorize" && method === "POST") {
    const form = new URLSearchParams(await readBody(req));
    const request = authorizeRequestFrom((name) => form.get(name) ?? undefined);
    const email = form.get("email") ?? "";
    const password = form.get("password") ?? "";
    try {
      const code = await provider.completeAuthorization(request, email, password);
      const location = new URL(request.redirectUri);
      location.searchParams.set("code", code);
      const state = form.get("state");
      if (state) location.searchParams.set("state", state);
      res.writeHead(302, { Location: location.href, "Cache-Control": "no-store" });
      res.end();
    } catch (error) {
      if (error instanceof PortalAuthError) {
        // Bad SmartBill credentials — keep the user on the form to retry.
        const client = await provider.validateAuthorizeRequest(request).catch(() => undefined);
        sendHtml(
          res,
          401,
          renderAuthorizePage({
            params: formParams(form),
            clientName: client?.clientName,
            error: "SmartBill did not accept that email and password. Please try again.",
          }),
        );
        return true;
      }
      sendHtml(res, 400, errorPage(error));
    }
    return true;
  }

  if (path === "/token" && method === "POST") {
    try {
      const form = new URLSearchParams(await readBody(req));
      const grantType = form.get("grant_type");
      let tokens;
      if (grantType === "authorization_code") {
        tokens = await provider.exchangeCode({
          code: form.get("code") ?? "",
          codeVerifier: form.get("code_verifier") ?? undefined,
          redirectUri: form.get("redirect_uri") ?? undefined,
          clientId: form.get("client_id") ?? undefined,
        });
      } else if (grantType === "refresh_token") {
        tokens = await provider.exchangeRefreshToken({
          refreshToken: form.get("refresh_token") ?? "",
          clientId: form.get("client_id") ?? undefined,
        });
      } else {
        throw new OAuthError("unsupported_grant_type", `Unsupported grant_type: ${grantType ?? "(none)"}.`);
      }
      sendJson(res, 200, tokens, { ...CORS_HEADERS, "Cache-Control": "no-store" });
    } catch (error) {
      sendOAuthError(res, error);
    }
    return true;
  }

  if (path === "/revoke" && method === "POST") {
    try {
      const form = new URLSearchParams(await readBody(req));
      const token = form.get("token");
      if (token) await provider.revoke(token);
      // RFC 7009: respond 200 whether or not the token existed.
      sendJson(res, 200, {}, CORS_HEADERS);
    } catch (error) {
      sendOAuthError(res, error);
    }
    return true;
  }

  // A known OAuth path with the wrong method.
  sendJson(res, 405, { error: "method_not_allowed" }, CORS_HEADERS);
  return true;
}

function queryParams(url: URL): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of url.searchParams) out[key] = value;
  return out;
}

function formParams(form: URLSearchParams): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of form) {
    if (key !== "password") out[key] = value;
  }
  return out;
}

function sendOAuthError(res: ServerResponse, error: unknown): void {
  if (error instanceof OAuthError) {
    sendJson(res, error.status, { error: error.code, error_description: error.message }, CORS_HEADERS);
    return;
  }
  sendJson(res, 400, { error: "invalid_request", error_description: "The request could not be processed." }, CORS_HEADERS);
}

function errorPage(error: unknown): string {
  const message = error instanceof OAuthError ? error.message : "The authorization request was invalid.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization error</title>
<style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
max-width:32rem;margin:4rem auto;padding:0 1rem;color:#16191d}h1{font-size:1.3rem}</style></head>
<body><h1>Couldn't start authorization</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
