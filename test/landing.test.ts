import { describe, expect, it } from "vitest";
import { renderHomePage } from "../src/landing.js";

describe("homepage", () => {
  it("is a marketing / overview page that shows the connector URL", () => {
    const html = renderHomePage("https://smartbill.example.com/mcp");

    expect(html).toContain("SmartBill MCP");
    // The connector URL is shown for the user to copy.
    expect(html).toContain("https://smartbill.example.com/mcp");
    // It explains the OAuth-style connect flow, not a credential form.
    expect(html).toContain("Add custom connector");
    expect(html).toContain("Authorize with SmartBill");
    // No password field on the homepage any more — sign-in happens on /authorize.
    expect(html).not.toContain('type="password"');
  });

  it("styles for both light and dark browsers", () => {
    expect(renderHomePage("https://x/mcp")).toContain("prefers-color-scheme: dark");
  });
});
