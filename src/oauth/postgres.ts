// Postgres-backed OAuth store. Codes and tokens are keyed by their SHA-256 hash,
// so the raw secret is never stored. Shares the connection pool with the tenant
// store (both are created in portal/setup.ts).

import pg from "pg";
import type { OAuthStore, StoredClient, StoredCode, StoredToken } from "./store.js";

const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id                  text PRIMARY KEY,
    client_name                text,
    redirect_uris              jsonb NOT NULL,
    token_endpoint_auth_method text NOT NULL DEFAULT 'none',
    grant_types                jsonb NOT NULL,
    created_at                 timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash      text PRIMARY KEY,
    client_id      text NOT NULL,
    tenant_email   text NOT NULL,
    redirect_uri   text NOT NULL,
    code_challenge text NOT NULL,
    resource       text,
    scope          text,
    expires_at     timestamptz NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash   text PRIMARY KEY,
    kind         text NOT NULL,
    client_id    text NOT NULL,
    tenant_email text NOT NULL,
    scope        text,
    expires_at   timestamptz
  );
`;

interface ClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  created_at: Date;
}
interface CodeRow {
  client_id: string;
  tenant_email: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string | null;
  scope: string | null;
  expires_at: Date;
}
interface TokenRow {
  kind: string;
  client_id: string;
  tenant_email: string;
  scope: string | null;
  expires_at: Date | null;
}

export class PostgresOAuthStore implements OAuthStore {
  constructor(private readonly pool: pg.Pool) {}

  async init(): Promise<void> {
    await this.pool.query(CREATE_TABLES);
  }

  async saveClient(client: StoredClient): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method, grant_types)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (client_id) DO NOTHING`,
      [
        client.clientId,
        client.clientName ?? null,
        JSON.stringify(client.redirectUris),
        client.tokenEndpointAuthMethod,
        JSON.stringify(client.grantTypes),
      ],
    );
  }

  async getClient(clientId: string): Promise<StoredClient | null> {
    const { rows } = await this.pool.query<ClientRow>("SELECT * FROM oauth_clients WHERE client_id = $1", [clientId]);
    const row = rows[0];
    if (!row) return null;
    return {
      clientId: row.client_id,
      clientName: row.client_name ?? undefined,
      redirectUris: row.redirect_uris,
      tokenEndpointAuthMethod: row.token_endpoint_auth_method,
      grantTypes: row.grant_types,
      createdAt: row.created_at.getTime(),
    };
  }

  async saveCode(codeHash: string, data: StoredCode): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_codes (code_hash, client_id, tenant_email, redirect_uri, code_challenge, resource, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        codeHash,
        data.clientId,
        data.tenantEmail,
        data.redirectUri,
        data.codeChallenge,
        data.resource ?? null,
        data.scope ?? null,
        new Date(data.expiresAt),
      ],
    );
  }

  async takeCode(codeHash: string): Promise<StoredCode | null> {
    // DELETE ... RETURNING makes the read single-use in one atomic statement.
    const { rows } = await this.pool.query<CodeRow>("DELETE FROM oauth_codes WHERE code_hash = $1 RETURNING *", [
      codeHash,
    ]);
    const row = rows[0];
    if (!row) return null;
    return {
      clientId: row.client_id,
      tenantEmail: row.tenant_email,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      resource: row.resource ?? undefined,
      scope: row.scope ?? undefined,
      expiresAt: row.expires_at.getTime(),
    };
  }

  async saveToken(tokenHash: string, data: StoredToken): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, tenant_email, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        tokenHash,
        data.kind,
        data.clientId,
        data.tenantEmail,
        data.scope ?? null,
        data.expiresAt === null ? null : new Date(data.expiresAt),
      ],
    );
  }

  async getToken(tokenHash: string): Promise<StoredToken | null> {
    const { rows } = await this.pool.query<TokenRow>("SELECT * FROM oauth_tokens WHERE token_hash = $1", [tokenHash]);
    const row = rows[0];
    if (!row) return null;
    return {
      kind: row.kind === "refresh" ? "refresh" : "access",
      clientId: row.client_id,
      tenantEmail: row.tenant_email,
      scope: row.scope ?? undefined,
      expiresAt: row.expires_at ? row.expires_at.getTime() : null,
    };
  }

  async deleteToken(tokenHash: string): Promise<void> {
    await this.pool.query("DELETE FROM oauth_tokens WHERE token_hash = $1", [tokenHash]);
  }
}
