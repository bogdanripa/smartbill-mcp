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
import { API_TOKEN_PREFIX, type AuthorizeRequest, OAuthError, type OAuthProvider } from "./provider.js";

export interface OAuthContext {
  provider: OAuthProvider;
  /** Absolute base URL of this deployment, no trailing slash (e.g. https://host). */
  baseUrl: string;
  /** MCP endpoint path, e.g. /mcp. */
  mcpPath: string;
}

/**
 * What to tell someone whose sign-in failed, per stage.
 *
 * Four of the five stages are sign-ins that *succeeded*. Reporting all of them
 * as a rejected password is how a colleague ends up retyping a correct password
 * three times against a permissions problem, so each stage says what actually
 * went wrong and what to do about it.
 */
export function authFailureMessage(error: PortalAuthError): string {
  switch (error.stage) {
    case "credentials":
      // SmartBill's own wording, when it gave any: it separates a wrong password
      // from a locked or rate-limited account, and it is already in the language
      // the person signing in uses. Re-writing it in English would throw away the
      // only authoritative account of what went wrong.
      return error.portalText
        ? `SmartBill refused the sign-in: ${error.portalText}`
        : "SmartBill did not accept that email and password. Please try again.";
    case "security-code":
      return "SmartBill wants a confirmation code for this device, which this " +
        "connection cannot enter. Sign in to cloud.smartbill.ro in a browser " +
        "first and mark the device as trusted, then try again.";
    case "no-api-token":
      // This used to assert the account lacked API access. That was a guess, and
      // it was wrong: the token was present and the page had simply changed shape
      // under the scraper, so people were sent to an administrator over a bug on
      // this side. Say what was observed and let the page settle which it is.
      return "Signed in to SmartBill, but no API token could be read from the " +
        "integrations page. Open cloud.smartbill.ro/core/integrari/ — if a token " +
        "IS shown there, this is a fault on our side, not your account, so please " +
        "report it. If no token is shown, ask whoever administers the account to " +
        "enable API access for this user.";
    case "integrations":
      return "Signed in to SmartBill, but its integrations page did not load, so " +
        "the API token could not be read. This is usually temporary — try again " +
        "in a few minutes.";
    case "no-session":
      return "SmartBill accepted the sign-in but returned no session. This is a " +
        "problem on their side rather than with the password — try again shortly.";
    case "login-page":
      return "The SmartBill login page could not be read, so the sign-in was never " +
        "attempted. Nothing is wrong with the password; this needs looking at.";
  }
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
    path === "/revoke" ||
    path === "/api-tokens" ||
    path.startsWith("/api-tokens/");
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

  // ---- long-lived API tokens ---------------------------------------------
  // Minting authenticates with the SmartBill email and password, the same proof
  // of ownership the authorize page takes. Listing and revoking authenticate
  // with a bearer, so a machine can rotate its own credential unattended.

  if (path === "/api-tokens" && method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const email = typeof body.email === "string" ? body.email : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!email || !password) {
        sendJson(res, 400, { error: "invalid_request", message: "email and password are required." }, CORS_HEADERS);
        return true;
      }
      const created = await provider.createApiToken(email, password, {
        name: typeof body.name === "string" ? body.name : undefined,
        expiresInDays: typeof body.expires_in_days === "number" ? body.expires_in_days : undefined,
      });
      console.error(
        `smartbill-mcp: api token ${created.id} ("${created.name}") created for ${email}` +
        `, expires ${created.expiresAt === null ? "never" : new Date(created.expiresAt).toISOString()}`,
      );
      sendJson(res, 201, {
        token: created.token,
        id: created.id,
        name: created.name,
        created_at: new Date(created.createdAt).toISOString(),
        expires_at: created.expiresAt === null ? null : new Date(created.expiresAt).toISOString(),
        note: "Store this now — only its hash is kept, so it cannot be shown again.",
      }, CORS_HEADERS);
    } catch (error) {
      if (error instanceof PortalAuthError) {
        console.error(
          `smartbill-mcp: api token request failed at stage=${error.stage}: ${error.message}`);
        sendJson(res, 401, { error: "invalid_grant", message: authFailureMessage(error) }, CORS_HEADERS);
        return true;
      }
      sendOAuthError(res, error);
    }
    return true;
  }

  if (path === "/api-tokens" && method === "GET") {
    const tenant = await tenantFromBearer(req, provider);
    if (!tenant) return unauthorized(res);
    const tokens = await provider.listApiTokens(tenant);
    sendJson(res, 200, {
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        created_at: new Date(t.createdAt).toISOString(),
        last_used_at: t.lastUsedAt === null ? null : new Date(t.lastUsedAt).toISOString(),
        expires_at: t.expiresAt === null ? null : new Date(t.expiresAt).toISOString(),
      })),
    }, CORS_HEADERS);
    return true;
  }

  if (path.startsWith("/api-tokens/") && method === "DELETE") {
    const tenant = await tenantFromBearer(req, provider);
    if (!tenant) return unauthorized(res);
    const id = decodeURIComponent(path.slice("/api-tokens/".length));
    const removed = await provider.revokeApiToken(tenant, id);
    if (!removed) {
      sendJson(res, 404, { error: "not_found", message: `No API token ${id} on this account.` }, CORS_HEADERS);
      return true;
    }
    console.error(`smartbill-mcp: api token ${id} revoked for ${tenant}`);
    res.writeHead(204, CORS_HEADERS);
    res.end();
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
        // Only "credentials" is a wrong password. Saying so for the others sent
        // people back to re-type a password that was never the problem, and left
        // nothing on the box to diagnose it with — hence the log line too.
        console.error(
          `smartbill-mcp: authorize failed for ${email || "(no email)"} ` +
          `at stage=${error.stage}: ${error.message}`,
        );
        const client = await provider.validateAuthorizeRequest(request).catch(() => undefined);
        sendHtml(
          res,
          401,
          renderAuthorizePage({
            params: formParams(form),
            clientName: client?.clientName,
            error: authFailureMessage(error),
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

/**
 * The account behind an `Authorization: Bearer`, for the token-management
 * endpoints. Accepts either kind of bearer — an OAuth access token or a
 * long-lived API token — so a machine client can manage its own credentials
 * with the credential it already has.
 */
async function tenantFromBearer(
  req: IncomingMessage,
  provider: OAuthProvider,
): Promise<string | null> {
  const header = req.headers.authorization;
  const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  if (!match?.[1]) return null;
  const token = match[1].trim();
  try {
    const resolved = token.startsWith(API_TOKEN_PREFIX)
      ? await provider.verifyApiToken(token)
      : await provider.verifyBearer(token);
    return resolved.username;
  } catch (error) {
    if (error instanceof OAuthError) return null;
    throw error;
  }
}

function unauthorized(res: ServerResponse): boolean {
  sendJson(res, 401, {
    error: "invalid_token",
    message: "A valid bearer token is required to manage API tokens.",
  }, CORS_HEADERS);
  return true;
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
