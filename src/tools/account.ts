import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DOCUMENT_TYPES, isoDate } from "../schemas.js";
import { jsonResult, resolveSeries, type ToolContext } from "./shared.js";

/** SmartBill identifies series by the first letter of the document type. */
const SERIES_TYPE_CODES = {
  factura: "f",
  proforma: "p",
  chitanta: "c",
} as const;

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  const { client, config } = ctx;

  server.registerTool(
    "list_series",
    {
      title: "List document series",
      description:
        "List the document series configured on the account, each with the next number it will issue. Read-only " +
        "and cheap.\n\n" +
        "Call this whenever you need a `seriesName` and do not already have one, and after any call that fails " +
        "with an unknown-series error — rather than guessing a series name. Also answers 'what number will the " +
        "next invoice get?'.\n\n" +
        "`nextNumber` comes back as a plain integer, but documents are addressed by their printed number, with " +
        "leading zeros — pad it back out before passing it to another tool. It is also only a counter: the " +
        "document before it may have been deleted, so do not assume nextNumber minus one exists.",
      inputSchema: {
        documentType: z
          .enum(["factura", "proforma", "chitanta"])
          .optional()
          .describe("Restrict to one document type. Omit to list every series."),
        companyVatCode: z.string().optional().describe("Company CIF. Falls back to SMARTBILL_VAT_CODE."),
      },
      annotations: { title: "List document series", readOnlyHint: true },
    },
    async (args) =>
      jsonResult(
        await client.requestJson({
          method: "GET",
          path: "/series",
          query: {
            cif: args.companyVatCode ?? config.companyVatCode,
            type: args.documentType ? SERIES_TYPE_CODES[args.documentType] : undefined,
          },
        }),
      ),
  );

  server.registerTool(
    "list_taxes",
    {
      title: "List VAT rates",
      description:
        "List the VAT rates configured for the company, as name/percentage pairs. Read-only and cheap.\n\n" +
        "Call this before create_invoice or create_estimate whenever you are not certain which rate applies, and " +
        "copy the returned `taxName` and `taxPercentage` onto the line items verbatim. Romanian VAT rates and " +
        "their names change over time and differ per account, so do not rely on remembered values.",
      inputSchema: {
        companyVatCode: z.string().optional().describe("Company CIF. Falls back to SMARTBILL_VAT_CODE."),
      },
      annotations: { title: "List VAT rates", readOnlyHint: true },
    },
    async (args) =>
      jsonResult(
        await client.requestJson({
          method: "GET",
          path: "/tax",
          query: { cif: args.companyVatCode ?? config.companyVatCode },
        }),
      ),
  );

  server.registerTool(
    "list_stocks",
    {
      title: "List stock levels",
      description:
        "Read stock levels as of a date, optionally narrowed to one warehouse or one product. Read-only.\n\n" +
        "Use it to answer 'how many do we have left?', to check availability before invoicing with `useStock`, or " +
        "to report stock as it stood on a past date. Omitting `warehouseName` covers every warehouse; omitting " +
        "`date` reports today.",
      inputSchema: {
        date: isoDate.optional().describe("Date to report stock for (YYYY-MM-DD). Defaults to today."),
        warehouseName: z.string().optional().describe("Warehouse name. Omit for all warehouses."),
        productName: z.string().optional().describe("Narrow to a single product by name."),
        productCode: z.string().optional().describe("Narrow to a single product by code."),
        companyVatCode: z.string().optional().describe("Company CIF. Falls back to SMARTBILL_VAT_CODE."),
      },
      annotations: { title: "List stock levels", readOnlyHint: true },
    },
    async (args) =>
      jsonResult(
        await client.requestJson({
          method: "GET",
          path: "/stocks",
          query: {
            cif: args.companyVatCode ?? config.companyVatCode,
            date: args.date ?? new Date().toISOString().slice(0, 10),
            warehouseName: args.warehouseName,
            productName: args.productName,
            productCode: args.productCode,
          },
        }),
      ),
  );

  server.registerTool(
    "send_document_email",
    {
      title: "Email a document",
      description:
        "Send an invoice or proforma that already exists to the client by email, with the PDF attached by " +
        "SmartBill. Use this when the user asks to send or resend a document.\n\n" +
        "Omit `to`, `subject` or `bodyText` to use the client's stored address and the templates configured in the " +
        "SmartBill account — usually the right choice. Pass plain text for the subject and body; encoding is " +
        "handled for you.\n\n" +
        "To email a document at the moment it is issued instead, set `sendEmail: true` on create_invoice or " +
        "create_estimate rather than calling this afterwards. This sends real mail to a customer: confirm the " +
        "recipient with the user first.",
      inputSchema: {
        documentType: z.enum(DOCUMENT_TYPES).describe("Which document to send."),
        number: z.string().describe("Document number."),
        seriesName: z.string().optional().describe("Document series. Falls back to the configured default."),
        to: z.string().optional().describe("Recipient address."),
        cc: z.string().optional().describe("Carbon copy address."),
        bcc: z.string().optional().describe("Blind carbon copy address."),
        subject: z.string().optional().describe("Plain text; encoded for the API automatically."),
        bodyText: z.string().optional().describe("Plain text; encoded for the API automatically."),
        companyVatCode: z.string().optional().describe("Issuing company CIF. Falls back to SMARTBILL_VAT_CODE."),
      },
      annotations: { title: "Email a document", readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const seriesName =
        args.documentType === "proforma"
          ? resolveSeries(args.seriesName, config.defaultEstimateSeries, "SMARTBILL_ESTIMATE_SERIES")
          : resolveSeries(args.seriesName, config.defaultInvoiceSeries, "SMARTBILL_INVOICE_SERIES");

      const body: Record<string, unknown> = {
        companyVatCode: args.companyVatCode ?? config.companyVatCode,
        seriesName,
        number: args.number,
        type: args.documentType,
      };
      if (args.subject) body.subject = Buffer.from(args.subject, "utf8").toString("base64");
      if (args.bodyText) body.bodyText = Buffer.from(args.bodyText, "utf8").toString("base64");
      if (args.to) body.to = args.to;
      if (args.cc) body.cc = args.cc;
      if (args.bcc) body.bcc = args.bcc;

      return jsonResult(await client.requestJson({ method: "POST", path: "/document/send", body }));
    },
  );
}
