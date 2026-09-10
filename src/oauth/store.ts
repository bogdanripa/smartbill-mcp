// Storage for the OAuth authorization server: clients registered via Dynamic
// Client Registration, one-time authorization codes, and access/refresh tokens.
//
// Codes and tokens are stored HASHED (SHA-256) — a database leak never exposes a
// live bearer token or authorization code. An in-memory implementation backs the
// tests; the Postgres one (postgres.ts) is wired in production.

export interface StoredClient {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  grantTypes: string[];
  createdAt: number;
}

export interface StoredCode {
  clientId: string;
  tenantEmail: string;
  redirectUri: string;
  /** PKCE S256 challenge the client committed to at /authorize. */
  codeChallenge: string;
  resource?: string;
  scope?: string;
  /** ms epoch. */
  expiresAt: number;
}

export interface StoredToken {
  kind: "access" | "refresh";
  clientId: string;
  tenantEmail: string;
  scope?: string;
  /** ms epoch, or null for no expiry. */
  expiresAt: number | null;
}

/**
 * A long-lived, per-account credential for machine clients.
 *
 * OAuth access tokens last an hour and refresh tokens expire 30 days after issue
 * without being extended by use, so an unattended job re-authorises monthly or
 * breaks. These do not expire unless asked to, and are revoked by id rather than
 * by presenting the secret.
 */
export interface StoredApiToken {
  /** Short public identifier. Safe to display and to revoke by; not the secret. */
  id: string;
  tenantEmail: string;
  name: string;
  createdAt: number;
  /** ms epoch of the last request that used it, or null if never used. */
  lastUsedAt: number | null;
  /** ms epoch, or null for a token that never expires — the point of the feature. */
  expiresAt: number | null;
}

export interface OAuthStore {
  saveClient(client: StoredClient): Promise<void>;
  getClient(clientId: string): Promise<StoredClient | null>;
  saveCode(codeHash: string, data: StoredCode): Promise<void>;
  /** Returns and atomically DELETES the code — authorization codes are single-use. */
  takeCode(codeHash: string): Promise<StoredCode | null>;
  saveToken(tokenHash: string, data: StoredToken): Promise<void>;
  getToken(tokenHash: string): Promise<StoredToken | null>;
  deleteToken(tokenHash: string): Promise<void>;
  saveApiToken(tokenHash: string, data: StoredApiToken): Promise<void>;
  getApiToken(tokenHash: string): Promise<StoredApiToken | null>;
  /** Every token for one tenant, newest first. Secrets are not recoverable. */
  listApiTokens(tenantEmail: string): Promise<StoredApiToken[]>;
  /** Scoped to the tenant so one account cannot revoke another's. */
  deleteApiToken(tenantEmail: string, id: string): Promise<boolean>;
  touchApiToken(tokenHash: string, when: number): Promise<void>;
}

/** In-memory store for tests. */
export class InMemoryOAuthStore implements OAuthStore {
  private readonly clients = new Map<string, StoredClient>();
  private readonly codes = new Map<string, StoredCode>();
  private readonly tokens = new Map<string, StoredToken>();
  private readonly apiTokens = new Map<string, StoredApiToken>();

  async saveClient(client: StoredClient): Promise<void> {
    this.clients.set(client.clientId, client);
  }
  async getClient(clientId: string): Promise<StoredClient | null> {
    return this.clients.get(clientId) ?? null;
  }
  async saveCode(codeHash: string, data: StoredCode): Promise<void> {
    this.codes.set(codeHash, data);
  }
  async takeCode(codeHash: string): Promise<StoredCode | null> {
    const code = this.codes.get(codeHash) ?? null;
    this.codes.delete(codeHash);
    return code;
  }
  async saveToken(tokenHash: string, data: StoredToken): Promise<void> {
    this.tokens.set(tokenHash, data);
  }
  async getToken(tokenHash: string): Promise<StoredToken | null> {
    return this.tokens.get(tokenHash) ?? null;
  }
  async deleteToken(tokenHash: string): Promise<void> {
    this.tokens.delete(tokenHash);
  }
  async saveApiToken(tokenHash: string, data: StoredApiToken): Promise<void> {
    this.apiTokens.set(tokenHash, data);
  }
  async getApiToken(tokenHash: string): Promise<StoredApiToken | null> {
    return this.apiTokens.get(tokenHash) ?? null;
  }
  async listApiTokens(tenantEmail: string): Promise<StoredApiToken[]> {
    return [...this.apiTokens.values()]
      .filter((t) => t.tenantEmail === tenantEmail)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async deleteApiToken(tenantEmail: string, id: string): Promise<boolean> {
    for (const [hash, tok] of this.apiTokens) {
      if (tok.id === id && tok.tenantEmail === tenantEmail) {
        this.apiTokens.delete(hash);
        return true;
      }
    }
    return false;
  }
  async touchApiToken(tokenHash: string, when: number): Promise<void> {
    const tok = this.apiTokens.get(tokenHash);
    if (tok) tok.lastUsedAt = when;
  }
}
