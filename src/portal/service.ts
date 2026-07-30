// Orchestrates the portal: ties the tenant store to the raw session. Handles
// re-login on session expiry (once per call), the consecutive-failure breaker
// that flips an account to needs-manual, and onboarding (login + token scrape).

import type { TenantStore } from "../store/tenants.js";
import { ENDPOINTS, type PortalEndpointName, type PortalParams } from "./endpoints.js";
import {
  isUnauthenticated,
  login,
  PortalAuthError,
  request,
  scrapeApiCredentials,
  type PortalCookies,
} from "./session.js";

/** Consecutive failed auto-relogins before an account is frozen for manual re-entry. */
export const MAX_LOGIN_FAILURES = 3;

/** The account needs the user to re-enter credentials at the setup page. */
export class PortalNeedsManualError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalNeedsManualError";
  }
}

export interface OnboardResult {
  token: string;
  cif: string;
}

export class PortalService {
  constructor(
    private readonly store: TenantStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * The setup flow: log in, scrape the scoped API token + CIF, and persist the
   * tenant (credentials + fresh cookies, breaker reset). Returns the token/CIF
   * so the caller can build the connector URL.
   */
  async onboard(email: string, password: string): Promise<OnboardResult> {
    const cookies = await login(email, password, this.fetchImpl);
    const creds = await scrapeApiCredentials(cookies, this.fetchImpl);
    if (!creds.token || !creds.cif) {
      throw new PortalAuthError(
        "Signed in, but could not read the API token/CIF from the SmartBill integrations page.",
      );
    }
    await this.store.upsert({ email, token: creds.token, cif: creds.cif, password, cookies });
    return { token: creds.token, cif: creds.cif };
  }

  /**
   * Runs one portal report endpoint for a tenant, reusing the stored session and
   * re-logging in once if it has expired. Returns the parsed JSON.
   *
   * `token` and `cif` come from the request's MCP URL and must match what was
   * stored at onboarding — that match is what authorises the caller to drive
   * this tenant's stored session (the token is an owner-only secret).
   */
  async call(
    email: string,
    token: string,
    cif: string,
    endpointName: PortalEndpointName,
    params: PortalParams,
  ): Promise<unknown> {
    const tenant = await this.store.get(email);
    if (!tenant) {
      throw new PortalNeedsManualError(
        "This account is not set up for portal reports. Open the setup page and enter your SmartBill email and password.",
      );
    }
    if (tenant.token !== token || tenant.cif !== cif) {
      throw new PortalAuthError("The credentials in this connector URL do not match this SmartBill account.");
    }
    if (tenant.needsManual) {
      throw new PortalNeedsManualError(
        "Automatic sign-in to SmartBill has been disabled after repeated failures. Re-enter your email and password on the setup page.",
      );
    }

    const endpoint = ENDPOINTS[endpointName];
    const cookies: PortalCookies = { ...tenant.cookies };

    // First try with the stored session. A success also clears any lingering
    // failure count — the breaker only cares about *consecutive* relogin failures.
    let response = await request(cookies, endpoint, params, this.fetchImpl);
    if (!isUnauthenticated(response)) {
      await this.store.patch(email, { cookies, failCount: 0 });
      return parse(response.text);
    }

    // Session expired — re-login once, then retry.
    let fresh: PortalCookies;
    try {
      fresh = await login(tenant.email, tenant.password, this.fetchImpl);
    } catch (error) {
      const failCount = tenant.failCount + 1;
      const needsManual = failCount >= MAX_LOGIN_FAILURES;
      await this.store.patch(email, { failCount, needsManual });
      if (needsManual) {
        throw new PortalNeedsManualError(
          "SmartBill sign-in failed repeatedly. Re-enter your email and password on the setup page.",
        );
      }
      throw error instanceof PortalAuthError ? error : new PortalAuthError(String(error));
    }

    response = await request(fresh, endpoint, params, this.fetchImpl);
    // A fresh login that still comes back unauthenticated counts as a failure too.
    if (isUnauthenticated(response)) {
      const failCount = tenant.failCount + 1;
      const needsManual = failCount >= MAX_LOGIN_FAILURES;
      await this.store.patch(email, { failCount, needsManual });
      throw new PortalAuthError("SmartBill still rejected the request after re-authenticating.");
    }

    // Success: persist the new cookies and clear the breaker.
    await this.store.patch(email, { cookies: fresh, failCount: 0, needsManual: false });
    return parse(response.text);
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
