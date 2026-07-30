// Postgres-backed tenant store. The password and cookies are encrypted at rest
// with SMARTBILL_SESSION_KEY; the token and CIF are stored in the clear (they
// already travel in the MCP URL). DATABASE_URL is injected by the platform.

import pg from "pg";
import { decrypt, encrypt } from "./crypto.js";
import type { NewTenant, Tenant, TenantStore } from "./tenants.js";

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS tenants (
    email        text PRIMARY KEY,
    token        text NOT NULL,
    cif          text NOT NULL,
    password_enc text NOT NULL,
    cookies_enc  text NOT NULL,
    fail_count   integer NOT NULL DEFAULT 0,
    needs_manual boolean NOT NULL DEFAULT false,
    updated_at   timestamptz NOT NULL DEFAULT now()
  )
`;

interface TenantRow {
  email: string;
  token: string;
  cif: string;
  password_enc: string;
  cookies_enc: string;
  fail_count: number;
  needs_manual: boolean;
}

export class PostgresTenantStore implements TenantStore {
  private readonly pool: pg.Pool;

  constructor(
    connectionString: string,
    private readonly key: Buffer,
  ) {
    this.pool = new pg.Pool({ connectionString });
  }

  /** Creates the table if needed. Call once at startup. */
  async init(): Promise<void> {
    await this.pool.query(CREATE_TABLE);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private normalise(email: string): string {
    return email.trim().toLowerCase();
  }

  async get(email: string): Promise<Tenant | null> {
    const { rows } = await this.pool.query<TenantRow>("SELECT * FROM tenants WHERE email = $1", [
      this.normalise(email),
    ]);
    const row = rows[0];
    if (!row) return null;
    return {
      email: row.email,
      token: row.token,
      cif: row.cif,
      password: decrypt(row.password_enc, this.key),
      cookies: JSON.parse(decrypt(row.cookies_enc, this.key)) as Record<string, string>,
      failCount: row.fail_count,
      needsManual: row.needs_manual,
    };
  }

  async upsert(tenant: NewTenant): Promise<void> {
    await this.pool.query(
      `INSERT INTO tenants (email, token, cif, password_enc, cookies_enc, fail_count, needs_manual, updated_at)
       VALUES ($1, $2, $3, $4, $5, 0, false, now())
       ON CONFLICT (email) DO UPDATE SET
         token = EXCLUDED.token,
         cif = EXCLUDED.cif,
         password_enc = EXCLUDED.password_enc,
         cookies_enc = EXCLUDED.cookies_enc,
         fail_count = 0,
         needs_manual = false,
         updated_at = now()`,
      [
        this.normalise(tenant.email),
        tenant.token,
        tenant.cif,
        encrypt(tenant.password, this.key),
        encrypt(JSON.stringify(tenant.cookies), this.key),
      ],
    );
  }

  async patch(
    email: string,
    fields: Partial<Pick<Tenant, "cookies" | "failCount" | "needsManual">>,
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (fields.cookies !== undefined) {
      sets.push(`cookies_enc = $${i++}`);
      values.push(encrypt(JSON.stringify(fields.cookies), this.key));
    }
    if (fields.failCount !== undefined) {
      sets.push(`fail_count = $${i++}`);
      values.push(fields.failCount);
    }
    if (fields.needsManual !== undefined) {
      sets.push(`needs_manual = $${i++}`);
      values.push(fields.needsManual);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = now()");
    values.push(this.normalise(email));
    await this.pool.query(`UPDATE tenants SET ${sets.join(", ")} WHERE email = $${i}`, values);
  }
}
