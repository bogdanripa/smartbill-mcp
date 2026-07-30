// The OAuth 2.1 authorization-server logic: Dynamic Client Registration, the
// authorization-code + PKCE flow, token issuance/refresh, bearer verification
// and revocation. Transport-agnostic — routes.ts adapts raw HTTP to this.
//
// SmartBill sign-in happens inside completeAuthorization: the user's credentials
// are handed to the portal service, which logs in, scrapes the API token + CIF,
// and stores the tenant. The authorization code is then bound to that tenant, so
// the access token the client ends up with maps back to it — the SmartBill token
// itself never leaves the server.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PortalService } from "../portal/service.js";
import type { TenantStore } from "../store/tenants.js";
import type { OAuthStore, StoredClient } from "./store.js";

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** An OAuth error carrying the RFC 6749 error code and the HTTP status to send. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface ClientMetadata {
  redirect_uris?: unknown;
  client_name?: unknown;
  grant_types?: unknown;
  token_endpoint_auth_method?: unknown;
}

export interface ClientInformation {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  client_name?: string;
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  responseType: string;
  resource?: string;
  scope?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/** Credentials resolved from a bearer token — what the MCP layer needs to serve. */
export interface ResolvedCredentials {
  username: string;
  token: string;
  companyVatCode: string;
}

function base64UrlSha256(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function randomToken(): string {
  return randomBytes(32).toString("base64url");
}
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Constant-time comparison of two equal-purpose strings. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** A redirect URI must be an absolute https URL, or http on loopback for local dev. */
function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

export class OAuthProvider {
  constructor(
    private readonly store: OAuthStore,
    private readonly tenants: TenantStore,
    private readonly portal: PortalService,
    private readonly now: () => number = Date.now,
  ) {}

  /** Dynamic Client Registration (RFC 7591). Public clients only — no secret issued. */
  async registerClient(metadata: ClientMetadata): Promise<ClientInformation> {
    const redirectUris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [];
    if (redirectUris.length === 0 || !redirectUris.every((u) => typeof u === "string" && isAllowedRedirectUri(u))) {
      throw new OAuthError("invalid_client_metadata", "redirect_uris must be one or more absolute https URLs.");
    }
    const grantTypes =
      Array.isArray(metadata.grant_types) && metadata.grant_types.length > 0
        ? (metadata.grant_types as string[])
        : ["authorization_code", "refresh_token"];
    const clientName = typeof metadata.client_name === "string" ? metadata.client_name : undefined;

    const client: StoredClient = {
      clientId: randomToken(),
      clientName,
      redirectUris: redirectUris as string[],
      tokenEndpointAuthMethod: "none",
      grantTypes,
      createdAt: this.now(),
    };
    await this.store.saveClient(client);

    return {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: client.grantTypes,
      response_types: ["code"],
      client_name: clientName,
    };
  }

  /**
   * Validates an /authorize request before anything is shown to the user, so an
   * unregistered client or redirect_uri never receives a code or a redirect.
   */
  async validateAuthorizeRequest(req: AuthorizeRequest): Promise<StoredClient> {
    const client = await this.store.getClient(req.clientId);
    if (!client) throw new OAuthError("invalid_client", "Unknown client_id.");
    if (!client.redirectUris.includes(req.redirectUri)) {
      throw new OAuthError("invalid_request", "redirect_uri does not match a registered value.");
    }
    if (req.responseType !== "code") {
      throw new OAuthError("unsupported_response_type", "Only response_type=code is supported.");
    }
    if (!req.codeChallenge || req.codeChallengeMethod !== "S256") {
      throw new OAuthError("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    }
    return client;
  }

  /**
   * Called after the user signs in on the /authorize page. Onboards the tenant
   * (SmartBill login + token scrape) and, on success, mints a one-time
   * authorization code bound to that tenant. Throws (letting the caller re-show
   * the form) if SmartBill rejects the credentials.
   */
  async completeAuthorization(req: AuthorizeRequest, email: string, password: string): Promise<string> {
    await this.validateAuthorizeRequest(req);
    await this.portal.onboard(email, password); // throws PortalAuthError on bad credentials
    const code = randomToken();
    await this.store.saveCode(hashToken(code), {
      clientId: req.clientId,
      tenantEmail: normaliseEmail(email),
      redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge,
      resource: req.resource,
      scope: req.scope,
      expiresAt: this.now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  /** Authorization-code grant: verify the code + PKCE, then issue tokens. */
  async exchangeCode(params: {
    code: string;
    codeVerifier?: string;
    redirectUri?: string;
    clientId?: string;
  }): Promise<TokenResponse> {
    const data = await this.store.takeCode(hashToken(params.code));
    if (!data) throw new OAuthError("invalid_grant", "Authorization code is invalid or was already used.");
    if (data.expiresAt <= this.now()) throw new OAuthError("invalid_grant", "Authorization code has expired.");
    if (params.clientId && data.clientId !== params.clientId) {
      throw new OAuthError("invalid_grant", "Authorization code was issued to a different client.");
    }
    if (data.redirectUri !== params.redirectUri) {
      throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request.");
    }
    if (!params.codeVerifier) throw new OAuthError("invalid_request", "code_verifier is required.");
    if (!safeEqual(base64UrlSha256(params.codeVerifier), data.codeChallenge)) {
      throw new OAuthError("invalid_grant", "PKCE verification failed.");
    }
    return this.issueTokens(data.clientId, data.tenantEmail, data.scope);
  }

  /** Refresh grant: verify the refresh token, then issue a fresh access token. */
  async exchangeRefreshToken(params: { refreshToken: string; clientId?: string }): Promise<TokenResponse> {
    const rec = await this.store.getToken(hashToken(params.refreshToken));
    if (!rec || rec.kind !== "refresh") throw new OAuthError("invalid_grant", "Invalid refresh token.");
    if (rec.expiresAt !== null && rec.expiresAt <= this.now()) {
      throw new OAuthError("invalid_grant", "Refresh token has expired.");
    }
    if (params.clientId && rec.clientId !== params.clientId) {
      throw new OAuthError("invalid_grant", "Refresh token was issued to a different client.");
    }
    return this.issueTokens(rec.clientId, rec.tenantEmail, rec.scope, params.refreshToken);
  }

  private async issueTokens(
    clientId: string,
    tenantEmail: string,
    scope: string | undefined,
    keepRefreshToken?: string,
  ): Promise<TokenResponse> {
    const accessToken = randomToken();
    await this.store.saveToken(hashToken(accessToken), {
      kind: "access",
      clientId,
      tenantEmail,
      scope,
      expiresAt: this.now() + ACCESS_TOKEN_TTL_MS,
    });

    let refreshToken = keepRefreshToken;
    if (!refreshToken) {
      refreshToken = randomToken();
      await this.store.saveToken(hashToken(refreshToken), {
        kind: "refresh",
        clientId,
        tenantEmail,
        scope,
        expiresAt: this.now() + REFRESH_TOKEN_TTL_MS,
      });
    }

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope,
    };
  }

  /**
   * Verifies a bearer access token and resolves the SmartBill credentials of the
   * tenant it belongs to. Throws OAuthError(401) if the token is bad or the
   * tenant has gone away.
   */
  async verifyBearer(accessToken: string): Promise<ResolvedCredentials> {
    const rec = await this.store.getToken(hashToken(accessToken));
    if (!rec || rec.kind !== "access") throw new OAuthError("invalid_token", "Invalid access token.", 401);
    if (rec.expiresAt !== null && rec.expiresAt <= this.now()) {
      throw new OAuthError("invalid_token", "Access token has expired.", 401);
    }
    const tenant = await this.tenants.get(rec.tenantEmail);
    if (!tenant) throw new OAuthError("invalid_token", "No SmartBill account is linked to this token.", 401);
    return { username: tenant.email, token: tenant.token, companyVatCode: tenant.cif };
  }

  /** Token revocation (RFC 7009). Accepts either an access or a refresh token. */
  async revoke(token: string): Promise<void> {
    await this.store.deleteToken(hashToken(token));
  }
}
