import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpTransport, listen as startListening, loadHttpOptions, type HttpOptions } from "../src/http.js";
import { OAuthProvider } from "../src/oauth/provider.js";
import { InMemoryOAuthStore } from "../src/oauth/store.js";
import type { HostedRuntime } from "../src/portal/setup.js";
import { PortalService } from "../src/portal/service.js";
import { InMemoryTenantStore } from "../src/store/tenants.js";
import { makeSmartBillStub } from "./helpers.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

/** Builds a hosted runtime (OAuth + portal) sharing one SmartBill fetch stub. */
function makeRuntime(fetchImpl: typeof fetch): HostedRuntime {
  const tenants = new InMemoryTenantStore();
  const portal = new PortalService(tenants, fetchImpl);
  const oauth = new OAuthProvider(new InMemoryOAuthStore(), tenants, portal);
  return { portal, oauth };
}

async function listen(overrides: Partial<HttpOptions> = {}, runtime?: HostedRuntime, fetchImpl?: typeof fetch) {
  const options: HttpOptions = { port: 0, host: "127.0.0.1", path: "/mcp", allowedHosts: [], ...overrides };
  const server = createHttpTransport(options, {} as NodeJS.ProcessEnv, fetchImpl, runtime);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}` };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

function postForm(url: string, params: Record<string, string>, redirect: RequestRedirect = "follow") {
  return fetch(url, {
    method: "POST",
    redirect,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

async function readJsonRpc(response: Response): Promise<any> {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const line = text.split("\n").find((candidate) => candidate.startsWith("data:"));
    return JSON.parse(line!.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Drives the whole OAuth flow against a running server and returns the access token. */
async function obtainAccessToken(base: string, email: string, password: string): Promise<string> {
  const registration = await (
    await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Test" }),
    })
  ).json();
  const clientId = registration.client_id as string;

  const { verifier, challenge } = pkce();
  const authorize = await postForm(
    `${base}/authorize`,
    {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      email,
      password,
    },
    "manual",
  );
  expect(authorize.status).toBe(302);
  const location = new URL(authorize.headers.get("location")!);
  expect(location.searchParams.get("state")).toBe("xyz");
  const code = location.searchParams.get("code")!;

  const tokenResponse = await postForm(`${base}/token`, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: clientId,
  });
  const tokens = await tokenResponse.json();
  return tokens.access_token as string;
}

describe("loadHttpOptions", () => {
  it("defaults to port 80 dual-stack", () => {
    expect(loadHttpOptions({} as NodeJS.ProcessEnv)).toMatchObject({ port: 80, host: "::", path: "/mcp", allowedHosts: [] });
  });

  it("rejects a port that is not a valid number", () => {
    expect(() => loadHttpOptions({ PORT: "http" } as NodeJS.ProcessEnv)).toThrow(/PORT/);
  });

  it("normalises a trailing slash on the mount path", () => {
    expect(loadHttpOptions({ MCP_PATH: "/smartbill/" } as NodeJS.ProcessEnv).path).toBe("/smartbill");
  });

  it("rejects a mount path without a leading slash", () => {
    expect(() => loadHttpOptions({ MCP_PATH: "smartbill" } as NodeJS.ProcessEnv)).toThrow(/leading slash|start with/);
  });

  it("parses a comma-separated allowed host list", () => {
    const options = loadHttpOptions({ MCP_ALLOWED_HOSTS: "a.example.com, b.example.com " } as NodeJS.ProcessEnv);
    expect(options.allowedHosts).toEqual(["a.example.com", "b.example.com"]);
  });
});

async function hasIpv6Loopback(): Promise<boolean> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "::1", () => probe.close(() => resolve(true)));
  });
}

describe("listen", () => {
  it("rejects with an actionable message when the port is taken", async () => {
    const first = createHttpTransport({ port: 0, host: "127.0.0.1", path: "/mcp", allowedHosts: [] });
    servers.push(first);
    await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
    const { port } = first.address() as AddressInfo;

    const second = createHttpTransport({ port, host: "127.0.0.1", path: "/mcp", allowedHosts: [] });
    servers.push(second);

    await expect(startListening(second, { port, host: "127.0.0.1", path: "/mcp", allowedHosts: [] })).rejects.toThrow(
      /already in use/,
    );
  });

  it("explains an EACCES on a privileged port instead of hanging", async () => {
    const failing = new EventEmitter() as unknown as Server;
    (failing as unknown as { listen: () => void }).listen = () => {
      queueMicrotask(() =>
        (failing as unknown as EventEmitter).emit("error", Object.assign(new Error("permission denied"), { code: "EACCES" })),
      );
    };

    await expect(
      startListening(failing, { port: 80, host: "0.0.0.0", path: "/mcp", allowedHosts: [] }),
    ).rejects.toThrow(/CAP_NET_BIND_SERVICE/);
  });

  it("answers on both loopback families, so a healthcheck for `localhost` reaches it", async () => {
    const options: HttpOptions = { port: 0, host: "::", path: "/mcp", allowedHosts: [] };
    const server = createHttpTransport(options);
    servers.push(server);
    await startListening(server, options);
    const { port } = server.address() as AddressInfo;

    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    if (await hasIpv6Loopback()) {
      for (const host of ["[::1]", "localhost"]) {
        expect((await fetch(`http://${host}:${port}/health`)).status, `${host} should answer`).toBe(200);
      }
    }
  });
});

describe("HTTP transport", () => {
  it("answers /health without credentials", async () => {
    const { base } = await listen();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", version: "0.1.0", commit: "dev" });
  });

  it("takes the build marker from the environment", async () => {
    vi.resetModules();
    process.env.BUILD_SHA = "abc1234";
    try {
      const { BUILD_SHA } = await import("../src/server.js");
      expect(BUILD_SHA).toBe("abc1234");
    } finally {
      delete process.env.BUILD_SHA;
      vi.resetModules();
    }
  });

  it("answers the root with JSON for API clients", async () => {
    const { base } = await listen();
    const response = await fetch(base);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ name: "smartbill-mcp", status: "ok", authorization: "oauth2" });
  });

  it("answers the root with the marketing homepage for a browser", async () => {
    const { base } = await listen();
    const response = await fetch(base, { headers: { Accept: "text/html" } });
    const html = await response.text();

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("SmartBill MCP");
    expect(html).toContain(`${base}/mcp`); // the connector URL is shown
    expect(html).not.toContain('type="password"'); // no setup form on the homepage
  });

  it("404s a path that is not the MCP endpoint", async () => {
    const { base } = await listen();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("refuses MCP requests with 503 when OAuth is not configured", async () => {
    const { base } = await listen(); // no runtime
    const response = await post(`${base}/mcp`, INITIALIZE);
    expect(response.status).toBe(503);
  });
});

describe("OAuth", () => {
  it("serves authorization-server metadata", async () => {
    const { base } = await listen({}, makeRuntime(makeSmartBillStub().impl));
    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();

    expect(meta.authorization_endpoint).toBe(`${base}/authorize`);
    expect(meta.token_endpoint).toBe(`${base}/token`);
    expect(meta.registration_endpoint).toBe(`${base}/register`);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.grant_types_supported).toContain("authorization_code");
  });

  it("serves protected-resource metadata pointing at the MCP endpoint", async () => {
    const { base } = await listen({}, makeRuntime(makeSmartBillStub().impl));
    const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();

    expect(meta.resource).toBe(`${base}/mcp`);
    expect(meta.authorization_servers).toContain(base);
  });

  it("challenges an unauthenticated MCP request with 401 + WWW-Authenticate", async () => {
    const { base } = await listen({}, makeRuntime(makeSmartBillStub().impl));
    const response = await post(`${base}/mcp`, INITIALIZE);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("shows the sign-in page for a valid authorize request", async () => {
    const runtime = makeRuntime(makeSmartBillStub().impl);
    const { base } = await listen({}, runtime);
    const client = await runtime.oauth.registerClient({ redirect_uris: [REDIRECT] });

    const { challenge } = pkce();
    const url = `${base}/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(
      REDIRECT,
    )}&code_challenge=${challenge}&code_challenge_method=S256`;
    const html = await (await fetch(url)).text();

    expect(html).toContain("Connect your SmartBill account");
    expect(html).toContain('name="password"');
    // The Authorize button shows a loading state on submit.
    expect(html).toContain('class="spin"');
    expect(html).toMatch(/addEventListener\(['"]submit['"]/);
  });

  it("rejects an authorize request for an unregistered redirect_uri without redirecting", async () => {
    const runtime = makeRuntime(makeSmartBillStub().impl);
    const { base } = await listen({}, runtime);
    const client = await runtime.oauth.registerClient({ redirect_uris: [REDIRECT] });

    const url = `${base}/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(
      "https://evil.example/cb",
    )}&code_challenge=abc&code_challenge_method=S256`;
    const response = await fetch(url, { redirect: "manual" });

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("re-shows the sign-in page when SmartBill rejects the credentials", async () => {
    const runtime = makeRuntime(makeSmartBillStub({ loginSucceeds: false }).impl);
    const { base } = await listen({}, runtime);
    const client = await runtime.oauth.registerClient({ redirect_uris: [REDIRECT] });
    const { challenge } = pkce();

    const response = await postForm(
      `${base}/authorize`,
      {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        email: "owner@example.com",
        password: "wrong",
      },
      "manual",
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("did not accept");
  });

  it("completes the flow end-to-end and authenticates an MCP call as the tenant", async () => {
    const stub = makeSmartBillStub({ apiToken: "003|scraped", cif: "RO999" });
    const runtime = makeRuntime(stub.impl);
    const { base } = await listen({}, runtime, stub.impl);

    const accessToken = await obtainAccessToken(base, "owner@example.com", "pw");
    expect(accessToken).toBeTruthy();

    const auth = { Authorization: `Bearer ${accessToken}` };
    const init = await post(`${base}/mcp`, INITIALIZE, auth);
    expect(init.status).toBe(200);
    expect((await readJsonRpc(init)).result.serverInfo.name).toBe("smartbill-mcp");

    const call = await readJsonRpc(
      await post(`${base}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_taxes", arguments: {} } }, auth),
    );
    expect(call.result.isError).toBeFalsy();

    // The public-API call carried the scraped tenant token + CIF.
    const taxCall = stub.calls.find((c) => c.url.includes("/SBORO/api/tax"));
    expect(taxCall?.url).toContain("cif=RO999");
    expect(taxCall?.headers.Authorization).toBe(`Basic ${Buffer.from("owner@example.com:003|scraped").toString("base64")}`);
  });

  it("rejects a revoked access token", async () => {
    const stub = makeSmartBillStub();
    const runtime = makeRuntime(stub.impl);
    const { base } = await listen({}, runtime, stub.impl);
    const accessToken = await obtainAccessToken(base, "owner@example.com", "pw");

    await postForm(`${base}/revoke`, { token: accessToken });

    const response = await post(`${base}/mcp`, INITIALIZE, { Authorization: `Bearer ${accessToken}` });
    expect(response.status).toBe(401);
  });
});
