// Builds the hosted-mode runtime — the portal report service and the OAuth
// authorization server — from the environment, sharing a single Postgres pool.
// Returns undefined when the portal is not configured (no DATABASE_URL /
// SMARTBILL_SESSION_KEY), in which case the HTTP server has no way to
// authenticate callers and refuses MCP requests.

import pg from "pg";
import { OAuthProvider } from "../oauth/provider.js";
import { PostgresOAuthStore } from "../oauth/postgres.js";
import { keyFromHex } from "../store/crypto.js";
import { PostgresTenantStore } from "../store/postgres.js";
import { PortalService } from "./service.js";

export interface HostedRuntime {
  portal: PortalService;
  oauth: OAuthProvider;
}

export async function createHostedRuntime(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<HostedRuntime | undefined> {
  const databaseUrl = env.DATABASE_URL?.trim();
  const sessionKey = env.SMARTBILL_SESSION_KEY?.trim();

  if (!databaseUrl || !sessionKey) {
    console.error(
      "smartbill-mcp: hosted mode disabled (need DATABASE_URL and SMARTBILL_SESSION_KEY). HTTP MCP requests will be refused.",
    );
    return undefined;
  }

  // A database hiccup must not leave the process crashing on every idle-client
  // drop, and a failure to initialise must not take the whole server down.
  try {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    pool.on("error", (error) => {
      console.error("smartbill-mcp: postgres pool error:", error instanceof Error ? error.message : error);
    });

    const key = keyFromHex(sessionKey);
    const tenants = new PostgresTenantStore(pool, key);
    const oauthStore = new PostgresOAuthStore(pool);
    await tenants.init();
    await oauthStore.init();

    const portal = new PortalService(tenants, fetchImpl);
    const oauth = new OAuthProvider(oauthStore, tenants, portal);
    console.error("smartbill-mcp: hosted mode enabled (OAuth + portal report tools).");
    return { portal, oauth };
  } catch (error) {
    console.error(
      "smartbill-mcp: hosted mode disabled — could not initialise the database:",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}
