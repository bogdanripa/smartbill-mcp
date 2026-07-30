// Builds the PortalService from the environment, or returns undefined when the
// portal is not configured (no DATABASE_URL / SMARTBILL_SESSION_KEY) — in which
// case the server runs exactly as before, with only the public-API tools.

import { keyFromHex } from "../store/crypto.js";
import { PostgresTenantStore } from "../store/postgres.js";
import { PortalService } from "./service.js";

export async function createPortalService(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<PortalService | undefined> {
  const databaseUrl = env.DATABASE_URL?.trim();
  const sessionKey = env.SMARTBILL_SESSION_KEY?.trim();

  if (!databaseUrl || !sessionKey) {
    console.error(
      "smartbill-mcp: portal report tools disabled (need DATABASE_URL and SMARTBILL_SESSION_KEY).",
    );
    return undefined;
  }

  const store = new PostgresTenantStore(databaseUrl, keyFromHex(sessionKey));
  await store.init();
  console.error("smartbill-mcp: portal report tools enabled.");
  return new PortalService(store, fetchImpl);
}
