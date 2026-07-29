import type { Credentials } from "./config.js";

export class CredentialError extends Error {}

/**
 * Credentials travel in one opaque URL segment: base64url of
 * `username:token:cif`. One segment keeps the MCP URL short and means a client
 * only has to be told a single value.
 */
export function encodeCredentials(credentials: Pick<Credentials, "username" | "token" | "companyVatCode">): string {
  const { username, token, companyVatCode } = credentials;
  if (username.includes(":")) {
    throw new CredentialError("The SmartBill username cannot contain a colon.");
  }
  if (companyVatCode.includes(":")) {
    throw new CredentialError("The company VAT code cannot contain a colon.");
  }
  return Buffer.from(`${username}:${token}:${companyVatCode}`, "utf8").toString("base64url");
}

export function decodeCredentials(segment: string): Pick<Credentials, "username" | "token" | "companyVatCode"> {
  let decoded: string;
  try {
    decoded = Buffer.from(segment, "base64url").toString("utf8");
  } catch {
    throw new CredentialError("Credentials segment is not valid base64url.");
  }

  // The token may itself contain colons, so anchor on the first and last field.
  const parts = decoded.split(":");
  if (parts.length < 3) {
    throw new CredentialError(
      "Credentials segment must decode to `username:token:cif`. Generate it with `npm run make-url`.",
    );
  }

  const username = parts[0]!.trim();
  const companyVatCode = parts[parts.length - 1]!.trim();
  const token = parts.slice(1, -1).join(":").trim();

  if (!username || !token || !companyVatCode) {
    throw new CredentialError("Credentials segment must contain a non-empty username, token and cif.");
  }

  return { username, token, companyVatCode };
}

/** Parses `Authorization: Basic base64(username:token)`. */
export function decodeBasicAuth(header: string): { username: string; token: string } {
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) {
    throw new CredentialError("Authorization header must use the Basic scheme.");
  }

  const decoded = Buffer.from(match[1].trim(), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 1) {
    throw new CredentialError("Basic credentials must decode to `username:token`.");
  }

  const username = decoded.slice(0, separator).trim();
  const token = decoded.slice(separator + 1).trim();
  if (!username || !token) {
    throw new CredentialError("Basic credentials must contain a non-empty username and token.");
  }

  return { username, token };
}
