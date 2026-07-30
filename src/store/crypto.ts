// Authenticated encryption for secrets at rest (the stored SmartBill password
// and session cookies). AES-256-GCM; the key is SMARTBILL_SESSION_KEY, 32 bytes
// as 64 hex chars. Payload layout: base64( iv(12) | tag(16) | ciphertext ).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function keyFromHex(hex: string | undefined): Buffer {
  const trimmed = hex?.trim() ?? "";
  const key = Buffer.from(trimmed, "hex");
  if (trimmed.length !== 64 || key.length !== 32) {
    throw new Error("SMARTBILL_SESSION_KEY must be 32 bytes as 64 hex characters.");
  }
  return key;
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

export function decrypt(payload: string, key: Buffer): string {
  const raw = Buffer.from(payload, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("Ciphertext is too short to be valid.");
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const enc = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
