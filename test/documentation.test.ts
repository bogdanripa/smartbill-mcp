import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { testConfig } from "./helpers.js";

/**
 * The tool descriptions are the only thing a model sees when deciding what to
 * call. These assertions keep them from silently degrading.
 */
let tools: Array<{ name: string; title?: string; description?: string; inputSchema: any; annotations?: any }>;
let instructions: string | undefined;

beforeAll(async () => {
  const server = createServer(testConfig());
  const client = new Client({ name: "docs", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  tools = (await client.listTools()).tools as typeof tools;
  instructions = client.getInstructions();
});

describe("server instructions", () => {
  it("explain the domain a model has to get right", () => {
    expect(instructions).toBeTruthy();
    for (const concept of ["series", "proforma", "list_taxes", "list_series", "storno", "isDraft"]) {
      expect(instructions).toContain(concept);
    }
  });

  it("say that documents cannot be searched, only fetched by series and number", () => {
    expect(instructions).toMatch(/only be fetched by series and number/i);
    expect(instructions).toMatch(/no search/i);
    expect(instructions).toMatch(/customer list/i);
  });
});

describe("tool documentation", () => {
  it("gives every tool a title and a substantive description", () => {
    for (const tool of tools) {
      expect(tool.title, `${tool.name} has no title`).toBeTruthy();
      expect(tool.description?.length ?? 0, `${tool.name} description is too thin`).toBeGreaterThan(120);
    }
  });

  it("says when to use each tool, not just what it does", () => {
    // Every description should orient the caller: either "use this when ..." or
    // an explicit pointer to the tool that should be used instead.
    for (const tool of tools) {
      const description = tool.description!.toLowerCase();
      const orients = /use (this|it)\b|call this|prefer this|use .*_/.test(description);
      expect(orients, `${tool.name} does not say when to use it`).toBe(true);
    }
  });

  it("cross-references the tools that are easy to confuse", () => {
    const byName = new Map(tools.map((tool) => [tool.name, tool.description!]));

    // Each pair is a mistake a model could plausibly make; the description of
    // the first tool must point at the second.
    const pairs: Array<[string, string]> = [
      ["create_invoice", "create_invoice_from_estimate"],
      ["create_invoice", "create_reverse_invoice"],
      ["delete_invoice", "cancel_invoice"],
      ["cancel_invoice", "create_reverse_invoice"],
      ["create_estimate", "create_invoice_from_estimate"],
      ["delete_estimate", "cancel_estimate"],
      ["get_invoice_pdf", "send_document_email"],
      ["get_invoice_payment_status", "create_payment"],
      ["create_payment", "create_invoice"],
      ["delete_payment", "delete_receipt"],
      ["send_document_email", "create_invoice"],
    ];

    for (const [from, to] of pairs) {
      expect(byName.get(from), `${from} should mention ${to}`).toContain(to);
    }
  });

  it("warns on the tools that touch real fiscal documents", () => {
    for (const name of ["delete_invoice", "delete_estimate", "delete_receipt", "delete_payment"]) {
      expect(
        /irreversible|confirm/i.test(tools.find((tool) => tool.name === name)!.description!),
        `${name} should warn that it is irreversible`,
      ).toBe(true);
    }
  });

  it("marks read-only tools as read-only and destructive ones as destructive", () => {
    const readOnly = [
      "get_invoice_pdf",
      "get_estimate_pdf",
      "get_invoice_payment_status",
      "get_estimate_invoices",
      "get_fiscal_receipt_text",
      "list_series",
      "list_taxes",
      "list_stocks",
    ];
    const destructive = [
      "cancel_invoice",
      "delete_invoice",
      "cancel_estimate",
      "delete_estimate",
      "delete_receipt",
      "delete_payment",
    ];

    for (const tool of tools) {
      if (readOnly.includes(tool.name)) {
        expect(tool.annotations?.readOnlyHint, `${tool.name} should be read-only`).toBe(true);
      }
      if (destructive.includes(tool.name)) {
        expect(tool.annotations?.destructiveHint, `${tool.name} should be destructive`).toBe(true);
        expect(tool.annotations?.readOnlyHint, `${tool.name} should not be read-only`).not.toBe(true);
      }
    }
  });

  it("describes every parameter of every tool", () => {
    const undocumented: string[] = [];

    const walk = (schema: any, path: string) => {
      for (const [name, property] of Object.entries<any>(schema?.properties ?? {})) {
        // anyOf/allOf wrappers carry the description on the outer node.
        const described = property.description ?? property.anyOf?.[0]?.description;
        if (!described) undocumented.push(`${path}.${name}`);

        if (property.type === "object") walk(property, `${path}.${name}`);
        if (property.type === "array" && property.items?.type === "object") {
          walk(property.items, `${path}.${name}[]`);
        }
      }
    };

    for (const tool of tools) walk(tool.inputSchema, tool.name);

    expect(undocumented).toEqual([]);
  });
});
