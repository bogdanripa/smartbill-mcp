#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  // The client can go away mid-write; that is a normal shutdown, not a crash.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });

  const config = loadConfig();
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // stdout carries the MCP protocol, so diagnostics have to go to stderr.
  console.error(error instanceof ConfigError ? message : `smartbill-mcp failed to start: ${message}`);
  process.exit(1);
});
