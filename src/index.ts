#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { createHttpTransport, listen, loadHttpOptions } from "./http.js";
import { createHostedRuntime } from "./portal/setup.js";
import { createServer } from "./server.js";

function wantsHttp(argv: string[], env: NodeJS.ProcessEnv): boolean {
  return argv.includes("--http") || env.MCP_TRANSPORT?.trim().toLowerCase() === "http";
}

async function main(): Promise<void> {
  // HTTP mode is multi-tenant: credentials arrive with each request, so the
  // server itself needs none and loadConfig() is deliberately not called.
  if (wantsHttp(process.argv.slice(2), process.env)) {
    const options = loadHttpOptions();
    // The hosted runtime (OAuth authorization server + portal report tools) needs
    // DATABASE_URL + SMARTBILL_SESSION_KEY. Without it the HTTP server has no way
    // to authenticate callers and refuses MCP requests.
    const runtime = await createHostedRuntime();
    const server = createHttpTransport(options, process.env, undefined, runtime);
    await listen(server, options);
    console.error(`smartbill-mcp listening on http://${options.host}:${options.port} (MCP at ${options.path})`);

    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => server.close(() => process.exit(0)));
    }
    return;
  }

  const config = loadConfig();

  // The client can go away mid-write; that is a normal shutdown, not a crash.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });

  const stdioServer = createServer(config);
  await stdioServer.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // stdout carries the MCP protocol, so diagnostics have to go to stderr.
  console.error(error instanceof ConfigError ? message : `smartbill-mcp failed to start: ${message}`);
  process.exit(1);
});
