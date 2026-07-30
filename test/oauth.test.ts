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
