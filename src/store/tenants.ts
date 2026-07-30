// The tenant record and its store. One row per SmartBill account (keyed by
// email): the scoped API token + CIF (also carried in the MCP URL), the stored
// login password and portal cookies (encrypted at rest by the Postgres impl),
// and the auto-relogin breaker (failCount / needsManual).
//
// This file defines the interface and an in-memory implementation for tests.
// The Postgres implementation lives in postgres.ts and is wired at startup.

import type { PortalCookies } from "../portal/session.js";

export interface Tenant {
  email: string;
  token: string;
  cif: string;
  /** SmartBill Cloud login password — used only to re-login when a session expires. */
  password: string;
  cookies: PortalCookies;
  /** Consecutive auto-relogin failures; reset on any success or re-onboarding. */
  failCount: number;
  /** True once failCount hits the breaker; portal tools then refuse until re-onboarding. */
  needsManual: boolean;
}

export type NewTenant = Pick<Tenant, "email" | "token" | "cif" | "password" | "cookies">;

export interface TenantStore {
  get(email: string): Promise<Tenant | null>;
  /** Onboarding upsert: stores credentials + fresh cookies and resets the breaker. */
  upsert(tenant: NewTenant): Promise<void>;
  /** Patch mutable session/breaker fields (refreshed cookies, failure counter). */
  patch(email: string, fields: Partial<Pick<Tenant, "cookies" | "failCount" | "needsManual">>): Promise<void>;
}

/** In-memory store for tests. Holds plaintext — the at-rest encryption is the Postgres impl's job. */
export class InMemoryTenantStore implements TenantStore {
  private readonly rows = new Map<string, Tenant>();

  private key(email: string): string {
    return email.trim().toLowerCase();
  }

  async get(email: string): Promise<Tenant | null> {
    const row = this.rows.get(this.key(email));
    return row ? { ...row, cookies: { ...row.cookies } } : null;
  }

  async upsert(tenant: NewTenant): Promise<void> {
    this.rows.set(this.key(tenant.email), {
      ...tenant,
      cookies: { ...tenant.cookies },
      failCount: 0,
      needsManual: false,
    });
  }

  async patch(
    email: string,
    fields: Partial<Pick<Tenant, "cookies" | "failCount" | "needsManual">>,
  ): Promise<void> {
    const row = this.rows.get(this.key(email));
    if (!row) return;
    if (fields.cookies !== undefined) row.cookies = { ...fields.cookies };
    if (fields.failCount !== undefined) row.failCount = fields.failCount;
    if (fields.needsManual !== undefined) row.needsManual = fields.needsManual;
  }
}
