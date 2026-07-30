import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, keyFromHex } from "../src/store/crypto.js";
import { InMemoryTenantStore } from "../src/store/tenants.js";

describe("crypto", () => {
  const key = keyFromHex(randomBytes(32).toString("hex"));

  it("round-trips through AES-256-GCM", () => {
    const secret = "003|8efc470a6eb1a2808f61ca3bcf24905e";
    expect(decrypt(encrypt(secret, key), key)).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encrypt("x", key)).not.toBe(encrypt("x", key));
  });

  it("fails to decrypt a tampered payload (auth tag)", () => {
    const enc = encrypt("sensitive", key);
    const raw = Buffer.from(enc, "base64");
    raw[raw.length - 1] ^= 0xff; // flip a ciphertext bit
    expect(() => decrypt(raw.toString("base64"), key)).toThrow();
  });

  it("rejects a key that is not 32 bytes of hex", () => {
    expect(() => keyFromHex("abc")).toThrow(/32 bytes/);
    expect(() => keyFromHex(undefined)).toThrow(/32 bytes/);
  });
});

describe("InMemoryTenantStore", () => {
  const base = {
    email: "me@example.com",
    token: "003|tok",
    cif: "RO123",
    password: "pw",
    cookies: { sessionid: "s1", csrftoken: "c1" },
  };

  it("upserts and reads back, case-insensitively on email", async () => {
    const store = new InMemoryTenantStore();
    await store.upsert(base);
    const got = await store.get("ME@EXAMPLE.COM");
    expect(got).toMatchObject({ token: "003|tok", cif: "RO123", failCount: 0, needsManual: false });
    expect(got?.cookies).toEqual({ sessionid: "s1", csrftoken: "c1" });
  });

  it("upsert resets the breaker", async () => {
    const store = new InMemoryTenantStore();
    await store.upsert(base);
    await store.patch(base.email, { failCount: 3, needsManual: true });
    await store.upsert({ ...base, password: "new" });
    const got = await store.get(base.email);
    expect(got).toMatchObject({ password: "new", failCount: 0, needsManual: false });
  });

  it("patches cookies and breaker fields independently", async () => {
    const store = new InMemoryTenantStore();
    await store.upsert(base);
    await store.patch(base.email, { cookies: { sessionid: "s2" } });
    await store.patch(base.email, { failCount: 2 });
    const got = await store.get(base.email);
    expect(got?.cookies).toEqual({ sessionid: "s2" });
    expect(got?.failCount).toBe(2);
    expect(got?.needsManual).toBe(false);
  });

  it("returns copies, so mutating a read does not corrupt the store", async () => {
    const store = new InMemoryTenantStore();
    await store.upsert(base);
    const first = await store.get(base.email);
    first!.cookies.sessionid = "hacked";
    const second = await store.get(base.email);
    expect(second?.cookies.sessionid).toBe("s1");
  });
});
