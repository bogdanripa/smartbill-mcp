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
        "List the document series configured in SmartBill, with their next number. Useful for discovering valid `seriesName` values.",
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
        "List the VAT rates configured for the company. Use the returned names and percentages for the `taxName` and `taxPercentage` fields on invoice lines.",
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
        "Read stock levels on a given date, optionally narrowed to one warehouse or product. " +
        "Omitting `warehouseName` returns every warehouse.",
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
        "Email an already-issued invoice or estimate to a client. When `to`, `subject` or `bodyText` are omitted, " +
        "SmartBill falls back to the client's address and the templates configured in the account.",
      inputSchema: {
        documentType: z.enum(DOCUMENT_TYPES).describe("Which document to send."),
        number: z.string().describe("Document number."),
        seriesName: z.string().optional().describe("Document series. Falls back to the configured default."),
        to: z.string().optional().describe("Recipient address."),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        subject: z.string().optional().describe("Plain text; encoded for the API automatically."),
        bodyText: z.string().optional().describe("Plain text; encoded for the API automatically."),
        companyVatCode: z.string().optional(),
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
