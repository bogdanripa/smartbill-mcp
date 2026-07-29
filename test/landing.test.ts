import { describe, expect, it } from "vitest";
import { decodeCredentials } from "../src/credentials.js";
import { CREDENTIAL_ENCODER_JS, renderLandingPage } from "../src/landing.js";

/**
 * The setup page encodes credentials in the browser and the server decodes them
 * on the way back in. If the two ever disagree, every URL the page hands out
 * 401s — so evaluate the page's own encoder and round-trip it.
 */
function browserEncoder(): (email: string, token: string, cif: string) => string {
  // eslint-disable-next-line no-new-func
  return new Function(`${CREDENTIAL_ENCODER_JS}; return encodeCredentials;`)() as ReturnType<
    typeof browserEncoder
  >;
}

describe("setup page credential encoder", () => {
  const encode = browserEncoder();

  it("round-trips through the server's decoder", () => {
    const credentials = { username: "you@company.ro", token: "003|8efc470a", companyVatCode: "RO48481960" };

    const segment = encode(credentials.username, credentials.token, credentials.companyVatCode);

    expect(decodeCredentials(segment)).toEqual(credentials);
  });

  it("survives a token containing a colon", () => {
    const credentials = { username: "you@company.ro", token: "a:b:c", companyVatCode: "RO1" };

    expect(decodeCredentials(encode("you@company.ro", "a:b:c", "RO1"))).toEqual(credentials);
  });

  it("survives non-ASCII characters", () => {
    const credentials = { username: "ionuț@companie.ro", token: "tökén", companyVatCode: "RO1" };

    expect(decodeCredentials(encode(credentials.username, credentials.token, credentials.companyVatCode))).toEqual(
      credentials,
    );
  });

  it("produces a URL-safe segment with no padding", () => {
    for (const token of ["??//++", "a", "ab", "abc", "003|8efc470a6eb1a2808f61ca3bcf24905e"]) {
      expect(encode("you@company.ro", token, "RO1")).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("matches the server-side encoder byte for byte", async () => {
    const { encodeCredentials } = await import("../src/credentials.js");

    expect(encode("you@company.ro", "003|abc", "RO1")).toBe(
      encodeCredentials({ username: "you@company.ro", token: "003|abc", companyVatCode: "RO1" }),
    );
  });
});

describe("setup page", () => {
  it("explains what the server does and how to get credentials", () => {
    const html = renderLandingPage("/mcp");

    expect(html).toContain("SmartBill MCP");
    expect(html).toContain("https://cloud.smartbill.ro/core/integrari/");
    expect(html).toContain("Contul Meu → Integrari → API");
    // Says plainly that nothing is transmitted, and that the URL is a secret.
    expect(html).toContain("Nothing you type here is sent anywhere");
    expect(html).toContain("Treat this URL like a password");
  });

  it("styles for both light and dark browsers", () => {
    expect(renderLandingPage("/mcp")).toContain("prefers-color-scheme: dark");
  });
});
