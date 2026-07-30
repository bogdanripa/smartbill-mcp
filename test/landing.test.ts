import { describe, expect, it } from "vitest";
import { renderLandingPage } from "../src/landing.js";

describe("setup page", () => {
  it("collects the SmartBill email and password and posts them to /setup", () => {
    const html = renderLandingPage("/mcp");

    expect(html).toContain("SmartBill MCP");
    // The two fields the new flow asks for — nothing else.
    expect(html).toContain('id="email"');
    expect(html).toContain('id="password"');
    // The page signs the user in server-side rather than encoding anything client-side.
    expect(html).toContain("/setup");
    // Says plainly the credentials are stored encrypted, and that the URL is a secret.
    expect(html).toContain("encrypted");
    expect(html).toContain("Treat this URL like a password");
  });

  it("builds the connector URL from the server response and the current origin", () => {
    const html = renderLandingPage("/mcp");

    // The result URL is location.origin + the path the server returns from /setup.
    expect(html).toContain("location.origin + data.url");
  });

  it("styles for both light and dark browsers", () => {
    expect(renderLandingPage("/mcp")).toContain("prefers-color-scheme: dark");
  });
});
