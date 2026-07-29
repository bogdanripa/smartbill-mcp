import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { decodeBasicAuth, decodeCredentials, encodeCredentials } from "../src/credentials.js";
import { createHttpTransport, loadHttpOptions, type HttpOptions } from "../src/http.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const CREDENTIALS = encodeCredentials({
  username: "you@example.com",
  token: "secret-token",
  companyVatCode: "RO12345678",
});

async function listen(overrides: Partial<HttpOptions> = {}) {
  const options: HttpOptions = { port: 0, host: "127.0.0.1", path: "/mcp", allowedHosts: [], ...overrides };
  const server = createHttpTransport(options, {} as NodeJS.ProcessEnv);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}` };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

/** The transport answers with either JSON or a single SSE event, depending on negotiation. */
async function readJsonRpc(response: Response): Promise<any> {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const line = text.split("\n").find((candidate) => candidate.startsWith("data:"));
    return JSON.parse(line!.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

describe("credential encoding", () => {
  it("round-trips a username, token and CIF", () => {
    const credentials = { username: "you@example.com", token: "abc-123", companyVatCode: "RO1" };

    expect(decodeCredentials(encodeCredentials(credentials))).toEqual(credentials);
  });

  it("keeps colons inside the token", () => {
    const credentials = { username: "you@example.com", token: "a:b:c", companyVatCode: "RO1" };

    expect(decodeCredentials(encodeCredentials(credentials))).toEqual(credentials);
  });

  it("produces a URL-safe segment", () => {
    const segment = encodeCredentials({
      username: "test+user@example.com",
      token: "??////",
      companyVatCode: "RO1",
    });

    expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects a segment with too few fields", () => {
    const segment = Buffer.from("you@example.com:token", "utf8").toString("base64url");

    expect(() => decodeCredentials(segment)).toThrow(/username:token:cif/);
  });

  it("rejects empty fields", () => {
    const segment = Buffer.from("you@example.com::RO1", "utf8").toString("base64url");

    expect(() => decodeCredentials(segment)).toThrow(/non-empty/);
  });

  it("parses a Basic authorization header", () => {
    const header = `Basic ${Buffer.from("you@example.com:tok:en").toString("base64")}`;

    expect(decodeBasicAuth(header)).toEqual({ username: "you@example.com", token: "tok:en" });
  });

  it("rejects a non-Basic scheme", () => {
    expect(() => decodeBasicAuth("Bearer abc")).toThrow(/Basic scheme/);
  });
});

describe("loadHttpOptions", () => {
  it("defaults to port 80 on all interfaces", () => {
    const options = loadHttpOptions({} as NodeJS.ProcessEnv);

    expect(options).toMatchObject({ port: 80, host: "0.0.0.0", path: "/mcp", allowedHosts: [] });
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

describe("HTTP transport", () => {
  it("answers /health without credentials, for platform health checks", async () => {
    const { base } = await listen();

    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves a landing page at the root that doubles as a health target", async () => {
    const { base } = await listen();

    const response = await fetch(base);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "smartbill-mcp", status: "ok" });
  });

  it("completes the MCP handshake with credentials in the URL", async () => {
    const { base } = await listen();

    const response = await post(`${base}/mcp/${CREDENTIALS}`, INITIALIZE);

    expect(response.status).toBe(200);
    expect((await readJsonRpc(response)).result.serverInfo.name).toBe("smartbill-mcp");
  });

  it("lists the tools over HTTP", async () => {
    const { base } = await listen();
    const url = `${base}/mcp/${CREDENTIALS}`;

    // Stateless mode: each request is self-contained, so tools/list needs no prior session.
    await post(url, INITIALIZE);
    const payload = await readJsonRpc(await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }));

    expect(payload.result.tools).toHaveLength(23);
  });

  it("accepts credentials in an Authorization header instead", async () => {
    const { base } = await listen();

    const response = await post(`${base}/mcp`, INITIALIZE, {
      Authorization: `Basic ${Buffer.from("you@example.com:secret-token").toString("base64")}`,
      "X-SmartBill-Cif": "RO12345678",
    });

    expect(response.status).toBe(200);
  });

  it("rejects header credentials with no CIF", async () => {
    const { base } = await listen();

    const response = await post(`${base}/mcp`, INITIALIZE, {
      Authorization: `Basic ${Buffer.from("you@example.com:secret-token").toString("base64")}`,
    });

    expect(response.status).toBe(401);
    expect((await response.json()).message).toContain("X-SmartBill-Cif");
  });

  it("rejects a request with no credentials at all", async () => {
    const { base } = await listen();

    const response = await post(`${base}/mcp`, INITIALIZE);

    expect(response.status).toBe(401);
  });

  it("rejects a malformed credentials segment", async () => {
    const { base } = await listen();

    const response = await post(`${base}/mcp/not-valid-credentials`, INITIALIZE);

    expect(response.status).toBe(401);
  });

  it("forwards each tenant's own credentials and CIF to SmartBill", async () => {
    const upstream: Array<{ url: string; authorization: string }> = [];
    const stub: typeof fetch = async (input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      upstream.push({ url: String(input), authorization: headers.Authorization ?? "" });
      return new Response(JSON.stringify({ errorText: "" }), {
        headers: { "content-type": "application/json" },
      });
    };

    const options: HttpOptions = { port: 0, host: "127.0.0.1", path: "/mcp", allowedHosts: [] };
    const server = createHttpTransport(options, {} as NodeJS.ProcessEnv, stub);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const tenants = [
      { username: "a@example.com", token: "token-a", companyVatCode: "RO111" },
      { username: "b@example.com", token: "token-b", companyVatCode: "RO222" },
    ];

    for (const tenant of tenants) {
      const url = `${base}/mcp/${encodeCredentials(tenant)}`;
      await post(url, INITIALIZE);
      const payload = await readJsonRpc(
        await post(url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_taxes", arguments: {} } }),
      );
      expect(payload.result.isError).toBeFalsy();
    }

    expect(upstream).toEqual([
      {
        url: "https://ws.smartbill.ro/SBORO/api/tax?cif=RO111",
        authorization: `Basic ${Buffer.from("a@example.com:token-a").toString("base64")}`,
      },
      {
        url: "https://ws.smartbill.ro/SBORO/api/tax?cif=RO222",
        authorization: `Basic ${Buffer.from("b@example.com:token-b").toString("base64")}`,
      },
    ]);
  });

  it("applies series defaults from the URL query string", async () => {
    const upstream: string[] = [];
    const stub: typeof fetch = async (input) => {
      upstream.push(String(input));
      return new Response(JSON.stringify({ errorText: "" }), {
        headers: { "content-type": "application/json" },
      });
    };

    const options: HttpOptions = { port: 0, host: "127.0.0.1", path: "/mcp", allowedHosts: [] };
    const server = createHttpTransport(options, {} as NodeJS.ProcessEnv, stub);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/mcp/${CREDENTIALS}?invoiceSeries=FF`;

    await post(url, INITIALIZE);
    const payload = await readJsonRpc(
      await post(url, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "cancel_invoice", arguments: { number: "120" } },
      }),
    );

    expect(payload.result.isError).toBeFalsy();
    expect(upstream[0]).toContain("seriesname=FF");
  });

  it("404s a path that is not the MCP endpoint", async () => {
    const { base } = await listen();

    const response = await fetch(`${base}/nope`);

    expect(response.status).toBe(404);
  });

  it("serves the MCP endpoint at a custom mount path", async () => {
    const { base } = await listen({ path: "/smartbill" });

    const response = await post(`${base}/smartbill/${CREDENTIALS}`, INITIALIZE);

    expect(response.status).toBe(200);
  });
});
