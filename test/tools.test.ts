import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import type { SmartBillConfig } from "../src/config.js";
import { stubFetch, testConfig, type StubResponse } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function connect(responses: StubResponse[], overrides: Partial<SmartBillConfig> = {}) {
  const { impl, calls } = stubFetch(responses);
  const server = createServer(testConfig(overrides), impl);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, calls };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((part) => part.text ?? "").join("");
}

function jsonOf(result: Awaited<ReturnType<Client["callTool"]>>): any {
  return JSON.parse(textOf(result));
}

describe("tool registration", () => {
  it("exposes every documented SmartBill operation", async () => {
    const { client } = await connect([]);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();

    expect(names).toEqual(
      [
        "cancel_estimate",
        "cancel_invoice",
        "cancel_payment",
        "create_estimate",
        "create_invoice",
        "create_invoice_from_estimate",
        "create_payment",
        "create_reverse_invoice",
        "delete_estimate",
        "delete_invoice",
        "delete_payment",
        "delete_receipt",
        "get_estimate_invoices",
        "get_estimate_pdf",
        "get_fiscal_receipt_text",
        "get_invoice_payment_status",
        "get_invoice_pdf",
        "list_series",
        "list_stocks",
        "list_taxes",
        "restore_estimate",
        "restore_invoice",
        "send_document_email",
      ].sort(),
    );
  });
});

describe("create_invoice", () => {
  it("builds the request body and applies the configured defaults", async () => {
    const { client, calls } = await connect([
      { json: { errorText: "", number: "120", series: "FF", url: "https://cloud.smartbill.ro/x" } },
    ]);

    const result = await client.callTool({
      name: "create_invoice",
      arguments: {
        client: { name: "ACME SRL", vatCode: "RO87654321", isTaxPayer: true, city: "Cluj" },
        products: [
          { name: "Consultanta", quantity: 3, price: 500, taxName: "Normala", taxPercentage: 21, isService: true },
        ],
        issueDate: "2026-07-29",
        dueDate: "2026-08-28",
        payment: { type: "Ordin plata", value: 1500 },
      },
    });

    expect(calls[0]!.url).toBe("https://ws.smartbill.ro/SBORO/api/invoice");
    expect(calls[0]!.body).toEqual({
      companyVatCode: "RO12345678",
      seriesName: "FF",
      issueDate: "2026-07-29",
      dueDate: "2026-08-28",
      client: { name: "ACME SRL", vatCode: "RO87654321", isTaxPayer: true, city: "Cluj" },
      products: [
        { name: "Consultanta", quantity: 3, price: 500, taxName: "Normala", taxPercentage: 21, isService: true },
      ],
      payment: { type: "Ordin plata", value: 1500 },
    });
    expect(jsonOf(result).number).toBe("120");
  });

  it("base64-encodes the email subject and body", async () => {
    const { client, calls } = await connect([{ json: { errorText: "", number: "1", series: "FF", url: "" } }]);

    await client.callTool({
      name: "create_invoice",
      arguments: {
        client: { name: "ACME SRL" },
        products: [{ name: "Serviciu", price: 100 }],
        sendEmail: true,
        email: { to: "office@acme.ro", subject: "Factura ta", bodyText: "Multumim!" },
      },
    });

    expect(calls[0]!.body).toMatchObject({
      sendEmail: true,
      email: {
        to: "office@acme.ro",
        subject: Buffer.from("Factura ta", "utf8").toString("base64"),
        bodyText: Buffer.from("Multumim!", "utf8").toString("base64"),
      },
    });
  });

  it("prefers an explicit series over the configured default", async () => {
    const { client, calls } = await connect([{ json: { errorText: "", number: "1", series: "AB", url: "" } }]);

    await client.callTool({
      name: "create_invoice",
      arguments: {
        seriesName: "AB",
        client: { name: "ACME SRL" },
        products: [{ name: "Serviciu", price: 100 }],
      },
    });

    expect((calls[0]!.body as any).seriesName).toBe("AB");
  });

  it("reports a missing series as a tool error naming the env var", async () => {
    const { client } = await connect([], { defaultInvoiceSeries: undefined });

    const result = await client.callTool({
      name: "create_invoice",
      arguments: { client: { name: "ACME SRL" }, products: [{ name: "Serviciu", price: 100 }] },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("SMARTBILL_INVOICE_SERIES");
  });

  it("rejects a malformed date before calling the API", async () => {
    const { client, calls } = await connect([]);

    const result = await client.callTool({
      name: "create_invoice",
      arguments: {
        client: { name: "ACME SRL" },
        products: [{ name: "Serviciu", price: 100 }],
        issueDate: "29-07-2026",
      },
    });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a SmartBill business error as a tool error", async () => {
    const { client } = await connect([{ json: { errorText: "Clientul nu poate fi identificat" } }]);

    const result = await client.callTool({
      name: "create_invoice",
      arguments: { client: { name: "ACME SRL" }, products: [{ name: "Serviciu", price: 100 }] },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Clientul nu poate fi identificat");
  });
});

describe("create_invoice_from_estimate", () => {
  it("references the estimate and issues into the invoice series", async () => {
    const { client, calls } = await connect([{ json: { errorText: "", number: "5", series: "FF", url: "" } }]);

    await client.callTool({
      name: "create_invoice_from_estimate",
      arguments: { estimateNumber: "42", issueDate: "2026-07-29" },
    });

    expect(calls[0]!.body).toEqual({
      companyVatCode: "RO12345678",
      seriesName: "FF",
      issueDate: "2026-07-29",
      useEstimateDetails: true,
      estimate: { seriesName: "PF", number: "42" },
    });
  });
});

describe("invoice lifecycle tools", () => {
  it("cancels an invoice with a PUT and the right query string", async () => {
    const { client, calls } = await connect([{ json: { errorText: "", message: "Anulata" } }]);

    await client.callTool({ name: "cancel_invoice", arguments: { number: "120" } });

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(
      "https://ws.smartbill.ro/SBORO/api/invoice/cancel?cif=RO12345678&seriesname=FF&number=120",
    );
  });

  it("deletes an invoice with a DELETE", async () => {
    const { client, calls } = await connect([{ json: { errorText: "" } }]);

    await client.callTool({ name: "delete_invoice", arguments: { number: "120", seriesName: "AB" } });

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(
      "https://ws.smartbill.ro/SBORO/api/invoice?cif=RO12345678&seriesname=AB&number=120",
    );
  });

  it("reads the payment status", async () => {
    const { client, calls } = await connect([
      {
        json: {
          errorText: "",
          series: "FF",
          number: "120",
          invoiceTotalAmount: 1785,
          paidAmount: 1000,
          unpaidAmount: 785,
          paid: false,
        },
      },
    ]);

    const result = await client.callTool({ name: "get_invoice_payment_status", arguments: { number: "120" } });

    expect(calls[0]!.url).toContain("/invoice/paymentstatus?cif=RO12345678&seriesname=FF&number=120");
    expect(jsonOf(result).unpaidAmount).toBe(785);
  });

  it("issues a storno invoice", async () => {
    const { client, calls } = await connect([{ json: { errorText: "", message: "ok" } }]);

    await client.callTool({
      name: "create_reverse_invoice",
      arguments: { number: "120", issueDate: "2026-07-29" },
    });

    expect(calls[0]!.url).toBe("https://ws.smartbill.ro/SBORO/api/invoice/reverse");
    expect(calls[0]!.body).toEqual({
      companyVatCode: "RO12345678",
      seriesName: "FF",
      number: "120",
      issueDate: "2026-07-29",
    });
  });
});

describe("PDF download", () => {
  it("writes the PDF to the download directory and returns its path", async () => {
    const downloadDir = path.join(tmpdir(), `smartbill-mcp-test-${process.pid}-${tempDirs.length}`);
    tempDirs.push(downloadDir);

    const { client, calls } = await connect(
      [
        {
          body: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
          headers: { "content-type": "application/octet-stream" },
        },
      ],
      { downloadDir },
    );

    const result = await client.callTool({ name: "get_invoice_pdf", arguments: { number: "120" } });
    const payload = jsonOf(result);

    expect(calls[0]!.headers.Accept).toBe("application/octet-stream");
    expect(calls[0]!.url).toBe(
      "https://ws.smartbill.ro/SBORO/api/invoice/pdf?cif=RO12345678&seriesname=FF&number=120",
    );
    expect(payload.filename).toBe("FF120.pdf");
    expect(payload.path).toBe(path.join(downloadDir, "FF120.pdf"));
    expect(await readFile(payload.path, "utf8")).toBe("%PDF-");
  });

  it("returns the bytes inline when asked for base64", async () => {
    const { client } = await connect([
      { body: new Uint8Array([0x25, 0x50, 0x44, 0x46]), headers: { "content-type": "application/octet-stream" } },
    ]);

    const payload = jsonOf(
      await client.callTool({ name: "get_estimate_pdf", arguments: { number: "42", as: "base64" } }),
    );

    expect(payload.base64).toBe(Buffer.from("%PDF").toString("base64"));
    expect(payload.byteLength).toBe(4);
    expect(payload.path).toBeUndefined();
  });
});

describe("payments", () => {
  it("sends the receipt series only for Chitanta", async () => {
    const { client, calls } = await connect([{ json: { errorText: "" } }, { json: { errorText: "" } }]);

    await client.callTool({
      name: "create_payment",
      arguments: { client: { name: "ACME SRL" }, value: 100, type: "Chitanta", invoices: [{ number: "120" }] },
    });
    await client.callTool({
      name: "create_payment",
      arguments: { client: { name: "ACME SRL" }, value: 100, type: "Ordin plata" },
    });

    expect(calls[0]!.body).toEqual({
      companyVatCode: "RO12345678",
      client: { name: "ACME SRL" },
      seriesName: "CH",
      value: 100,
      type: "Chitanta",
      invoicesList: [{ seriesName: "FF", number: "120" }],
    });
    expect((calls[1]!.body as any).seriesName).toBeUndefined();
  });

  it("requires enough information to identify a non-receipt payment", async () => {
    const { client, calls } = await connect([]);

    const result = await client.callTool({
      name: "delete_payment",
      arguments: { paymentType: "Ordin plata" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("invoiceNumber");
    expect(calls).toHaveLength(0);
  });

  it("deletes a payment identified by the invoice it settles", async () => {
    const { client, calls } = await connect([{ json: { errorText: "" } }]);

    await client.callTool({
      name: "delete_payment",
      arguments: { paymentType: "Card", invoiceNumber: "120" },
    });

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(
      "https://ws.smartbill.ro/SBORO/api/payment?cif=RO12345678&paymentType=Card&invoiceSeries=FF&invoiceNumber=120",
    );
  });

  it("decodes the base64 fiscal receipt text", async () => {
    const encoded = Buffer.from("BON FISCAL\nTotal 100 RON", "utf8").toString("base64");
    const { client } = await connect([{ json: { errorText: "", message: encoded } }]);

    const payload = jsonOf(await client.callTool({ name: "get_fiscal_receipt_text", arguments: { id: "77" } }));

    expect(payload.message).toBe("BON FISCAL\nTotal 100 RON");
  });
});

describe("account tools", () => {
  it("maps the document type to the single-letter series code", async () => {
    const { client, calls } = await connect([{ json: { errorText: "", list: [] } }]);

    await client.callTool({ name: "list_series", arguments: { documentType: "proforma" } });

    expect(calls[0]!.url).toBe("https://ws.smartbill.ro/SBORO/api/series?cif=RO12345678&type=p");
  });

  it("defaults the stock date to today", async () => {
    const { client, calls } = await connect([{ json: { errorText: "" } }]);

    await client.callTool({ name: "list_stocks", arguments: {} });

    const today = new Date().toISOString().slice(0, 10);
    expect(calls[0]!.url).toBe(`https://ws.smartbill.ro/SBORO/api/stocks?cif=RO12345678&date=${today}`);
  });

  it("emails a proforma using the estimate series", async () => {
    const { client, calls } = await connect([{ json: { status: { code: 0, message: "OK" } } }]);

    await client.callTool({
      name: "send_document_email",
      arguments: { documentType: "proforma", number: "42", to: "office@acme.ro", subject: "Proforma" },
    });

    expect(calls[0]!.url).toBe("https://ws.smartbill.ro/SBORO/api/document/send");
    expect(calls[0]!.body).toEqual({
      companyVatCode: "RO12345678",
      seriesName: "PF",
      number: "42",
      type: "proforma",
      subject: Buffer.from("Proforma", "utf8").toString("base64"),
      to: "office@acme.ro",
    });
  });
});
