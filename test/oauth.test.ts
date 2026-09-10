import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { OAuthError, OAuthProvider, type AuthorizeRequest } from "../src/oauth/provider.js";
import { InMemoryOAuthStore } from "../src/oauth/store.js";
import { PortalService } from "../src/portal/service.js";
import { PortalAuthError } from "../src/portal/session.js";
import { InMemoryTenantStore } from "../src/store/tenants.js";
import { makeSmartBillStub } from "./helpers.js";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const EMAIL = "owner@example.com";
const PASSWORD = "pw";

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("OAuthProvider", () => {
  let store: InMemoryOAuthStore;
  let tenants: InMemoryTenantStore;
  let provider: OAuthProvider;
  let clock: number;

  beforeEach(() => {
    store = new InMemoryOAuthStore();
    tenants = new InMemoryTenantStore();
    const portal = new PortalService(tenants, makeSmartBillStub({ apiToken: "003|abc", cif: "RO7" }).impl);
    clock = 1_000_000;
    provider = new OAuthProvider(store, tenants, portal, () => clock);
  });

  async function registerAndAuthorize(): Promise<{ clientId: string; request: AuthorizeRequest; verifier: string }> {
    const client = await provider.registerClient({ redirect_uris: [REDIRECT], client_name: "Claude" });
    const { verifier, challenge } = pkce();
    const request: AuthorizeRequest = {
      clientId: client.client_id,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      responseType: "code",
    };
    return { clientId: client.client_id, request, verifier };
  }

  it("registers a public client with PKCE and no secret", async () => {
    const client = await provider.registerClient({ redirect_uris: [REDIRECT], client_name: "Claude" });

    expect(client.client_id).toBeTruthy();
    expect(client.token_endpoint_auth_method).toBe("none");
    expect(client.response_types).toEqual(["code"]);
    expect(client).not.toHaveProperty("client_secret");
  });

  it("rejects registration without a valid https redirect_uri", async () => {
    await expect(provider.registerClient({ redirect_uris: [] })).rejects.toBeInstanceOf(OAuthError);
    await expect(provider.registerClient({ redirect_uris: ["ftp://x"] })).rejects.toBeInstanceOf(OAuthError);
  });

  it("rejects an authorize request for an unknown client or unregistered redirect", async () => {
    const client = await provider.registerClient({ redirect_uris: [REDIRECT] });
    const base: AuthorizeRequest = {
      clientId: client.client_id,
      redirectUri: REDIRECT,
      codeChallenge: "c",
      codeChallengeMethod: "S256",
      responseType: "code",
    };

    await expect(provider.validateAuthorizeRequest({ ...base, clientId: "nope" })).rejects.toBeInstanceOf(OAuthError);
    await expect(
      provider.validateAuthorizeRequest({ ...base, redirectUri: "https://evil.example/cb" }),
    ).rejects.toBeInstanceOf(OAuthError);
    await expect(
      provider.validateAuthorizeRequest({ ...base, codeChallengeMethod: "plain" }),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it("runs the full code+PKCE flow and resolves the tenant's credentials", async () => {
    const { request, verifier } = await registerAndAuthorize();

    const code = await provider.completeAuthorization(request, EMAIL, PASSWORD);
    const tokens = await provider.exchangeCode({
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
      clientId: request.clientId,
    });

    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    const creds = await provider.verifyBearer(tokens.access_token);
    expect(creds).toEqual({ username: EMAIL, token: "003|abc", companyVatCode: "RO7" });
  });

  it("rejects a code exchange with the wrong PKCE verifier", async () => {
    const { request } = await registerAndAuthorize();
    const code = await provider.completeAuthorization(request, EMAIL, PASSWORD);

    await expect(
      provider.exchangeCode({ code, codeVerifier: "wrong", redirectUri: REDIRECT, clientId: request.clientId }),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it("makes an authorization code single-use", async () => {
    const { request, verifier } = await registerAndAuthorize();
    const code = await provider.completeAuthorization(request, EMAIL, PASSWORD);

    await provider.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT, clientId: request.clientId });
    await expect(
      provider.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT, clientId: request.clientId }),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it("rejects an expired authorization code", async () => {
    const { request, verifier } = await registerAndAuthorize();
    const code = await provider.completeAuthorization(request, EMAIL, PASSWORD);

    clock += 10 * 60 * 1000; // past the 5-minute code TTL

    await expect(
      provider.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT, clientId: request.clientId }),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it("rejects a code exchange whose redirect_uri does not match", async () => {
    const { request, verifier } = await registerAndAuthorize();
    const code = await provider.completeAuthorization(request, EMAIL, PASSWORD);

    await expect(
      provider.exchangeCode({
        code,
        codeVerifier: verifier,
        redirectUri: "https://claude.ai/other",
        clientId: request.clientId,
      }),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it("refreshes an access token", async () => {
    const { request, verifier } = await registerAndAuthorize();
    const code = await provider.completeAuthorization(request, EMAIL, PASSWORD);
    const first = await provider.exchangeCode({
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
      clientId: request.clientId,
    });

    const refreshed = await provider.exchangeRefreshToken({
      refreshToken: first.refresh_token!,
      clientId: request.clientId,
    });

    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(first.access_token);
    await expect(provider.verifyBearer(refreshed.access_token)).resolves.toMatchObject({ username: EMAIL });
  });

  it("revokes an access token", async () => {
    const { request, verifier } = await registerAndAuthorize();
    const code = await provider.completeAuthorization(request, EMAIL, PASSWORD);
    const tokens = await provider.exchangeCode({
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
      clientId: request.clientId,
    });

    await provider.revoke(tokens.access_token);

    await expect(provider.verifyBearer(tokens.access_token)).rejects.toBeInstanceOf(OAuthError);
  });

  it("does not issue a code when SmartBill rejects the sign-in", async () => {
    const badPortal = new PortalService(new InMemoryTenantStore(), makeSmartBillStub({ loginSucceeds: false }).impl);
    const badProvider = new OAuthProvider(store, tenants, badPortal, () => clock);
    const client = await badProvider.registerClient({ redirect_uris: [REDIRECT] });
    const { challenge } = pkce();
    const request: AuthorizeRequest = {
      clientId: client.client_id,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      responseType: "code",
    };

    await expect(badProvider.completeAuthorization(request, EMAIL, "bad")).rejects.toBeInstanceOf(PortalAuthError);
  });
});

describe("long-lived API tokens", () => {
  // The reason this exists: an OAuth access token lasts an hour and its refresh
  // token dies 30 days after issue without being extended by use, so any
  // unattended job breaks monthly. These do not expire unless asked to.
  const API_TOKEN = "003|abc";
  const API_CIF = "RO7";

  let store: InMemoryOAuthStore;
  let tenants: InMemoryTenantStore;
  let provider: OAuthProvider;
  let clock: number;

  beforeEach(() => {
    store = new InMemoryOAuthStore();
    tenants = new InMemoryTenantStore();
    const portal = new PortalService(tenants, makeSmartBillStub({ apiToken: API_TOKEN, cif: API_CIF }).impl);
    clock = 1_000_000;
    provider = new OAuthProvider(store, tenants, portal, () => clock);
  });

  it("mints a token that resolves the account, and never expires by default", async () => {
    const created = await provider.createApiToken(EMAIL, PASSWORD, { name: "attio sync" });
    expect(created.token.startsWith("sbmcp_")).toBe(true);
    expect(created.expiresAt).toBeNull();

    const creds = await provider.verifyApiToken(created.token);
    expect(creds).toEqual({ username: EMAIL, token: API_TOKEN, companyVatCode: API_CIF });
  });

  it("refuses to mint one on bad SmartBill credentials", async () => {
    const badPortal = new PortalService(new InMemoryTenantStore(), makeSmartBillStub({ loginSucceeds: false }).impl);
    const badProvider = new OAuthProvider(store, tenants, badPortal, () => clock);
    await expect(badProvider.createApiToken(EMAIL, "wrong")).rejects.toBeInstanceOf(PortalAuthError);
  });

  it("honours an explicit expiry and rejects the token once past it", async () => {
    const created = await provider.createApiToken(EMAIL, PASSWORD, { expiresInDays: 7 });
    expect(created.expiresAt).toBe(clock + 7 * 24 * 60 * 60 * 1000);
    await expect(provider.verifyApiToken(created.token)).resolves.toMatchObject({ username: EMAIL });

    clock += 7 * 24 * 60 * 60 * 1000 + 1;
    await expect(provider.verifyApiToken(created.token)).rejects.toBeInstanceOf(OAuthError);
  });

  it("rejects a nonsense expiry rather than storing it", async () => {
    await expect(provider.createApiToken(EMAIL, PASSWORD, { expiresInDays: 0 }))
      .rejects.toBeInstanceOf(OAuthError);
    await expect(provider.createApiToken(EMAIL, PASSWORD, { expiresInDays: -5 }))
      .rejects.toBeInstanceOf(OAuthError);
  });

  it("lists tokens without ever exposing the secret", async () => {
    const created = await provider.createApiToken(EMAIL, PASSWORD, { name: "listed" });
    const listed = await provider.listApiTokens(EMAIL);
    expect(listed.find((t) => t.id === created.id)?.name).toBe("listed");
    expect(JSON.stringify(listed)).not.toContain(created.token);
  });

  it("revokes by id, and the token stops working immediately", async () => {
    const created = await provider.createApiToken(EMAIL, PASSWORD);
    await expect(provider.verifyApiToken(created.token)).resolves.toMatchObject({ username: EMAIL });

    expect(await provider.revokeApiToken(EMAIL, created.id)).toBe(true);
    await expect(provider.verifyApiToken(created.token)).rejects.toBeInstanceOf(OAuthError);
    expect(await provider.revokeApiToken(EMAIL, created.id)).toBe(false);
  });

  it("will not let one account revoke another account's token", async () => {
    const created = await provider.createApiToken(EMAIL, PASSWORD);
    expect(await provider.revokeApiToken("someone-else@example.com", created.id)).toBe(false);
    await expect(provider.verifyApiToken(created.token)).resolves.toMatchObject({ username: EMAIL });
  });

  it("keeps the two kinds of bearer apart", async () => {
    const created = await provider.createApiToken(EMAIL, PASSWORD);
    await expect(provider.verifyBearer(created.token)).rejects.toBeInstanceOf(OAuthError);
    await expect(provider.verifyApiToken("not-a-real-token")).rejects.toBeInstanceOf(OAuthError);
  });

  it("records last use, but not on every single call", async () => {
    const created = await provider.createApiToken(EMAIL, PASSWORD);
    const lastUsed = async () =>
      (await provider.listApiTokens(EMAIL)).find((t) => t.id === created.id)?.lastUsedAt;

    await provider.verifyApiToken(created.token);
    const first = await lastUsed();
    expect(first).toBe(clock);

    clock += 60 * 1000; // a minute later: too soon to write again
    await provider.verifyApiToken(created.token);
    expect(await lastUsed()).toBe(first);

    clock += 60 * 60 * 1000; // past the resolution window
    await provider.verifyApiToken(created.token);
    expect(await lastUsed()).toBe(clock);
  });
});
