import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { invoicePaymentSchema, isoDate, omitUndefined } from "../schemas.js";
import {
  buildDocumentBody,
  deliverPdf,
  documentBodySchema,
  documentDeliverySchema,
  jsonResult,
  resolveSeries,
  type ToolContext,
} from "./shared.js";

const INVOICE_SERIES_ENV = "SMARTBILL_INVOICE_SERIES";

const invoiceRefSchema = {
  number: z.string().describe("Invoice number, without the series prefix."),
  seriesName: z.string().optional().describe("Invoice series. Falls back to the configured default."),
  companyVatCode: z.string().optional().describe("Issuing company CIF. Falls back to SMARTBILL_VAT_CODE."),
};

export function registerInvoiceTools(server: McpServer, ctx: ToolContext): void {
  const { client, config } = ctx;

  const series = (explicit?: string) =>
    resolveSeries(explicit, config.defaultInvoiceSeries, INVOICE_SERIES_ENV);

  server.registerTool(
    "create_invoice",
    {
      title: "Create invoice",
      description:
        "Issue a new invoice in SmartBill. Returns the series, number and the SmartBill URL of the document. " +
        "Use `isDraft: true` to create it as a draft that still has to be confirmed in SmartBill.",
      inputSchema: {
        ...documentBodySchema,
        payment: invoicePaymentSchema
          .optional()
          .describe("Record a payment at the same time as the invoice is issued."),
        paymentDate: isoDate.optional().describe("Date of the payment recorded with the invoice."),
        paymentUrl: z.string().optional().describe("Payment link printed on the PDF."),
        useStock: z.boolean().optional().describe("Deduct the invoiced quantities from stock."),
        aviz: z.string().optional().describe("Delivery note number when invoicing an aviz."),
        usePaymentTax: z.boolean().optional().describe("Apply VAT on collection (TVA la incasare)."),
        paymentBase: z.number().optional().describe("Collected base amount, when usePaymentTax is true."),
        colectedTax: z.number().optional().describe("Collected VAT amount, when usePaymentTax is true."),
        paymentTotal: z.number().optional().describe("Total collected, when usePaymentTax is true."),
      },
      annotations: { title: "Create invoice", readOnlyHint: false, destructiveHint: false },
    },
    async ({ payment, ...args }) => {
      const body = {
        ...buildDocumentBody(args, series(args.seriesName), args.companyVatCode ?? config.companyVatCode),
        ...(payment ? { payment: omitUndefined(payment) } : {}),
      };
      return jsonResult(await client.requestJson({ method: "POST", path: "/invoice", body }));
    },
  );

  server.registerTool(
    "create_invoice_from_estimate",
    {
      title: "Create invoice from estimate",
      description:
        "Issue an invoice that copies its client and line items from an existing estimate (proforma). " +
        "`seriesName` is the invoice series; `estimateSeriesName` and `estimateNumber` identify the source estimate.",
      inputSchema: {
        estimateNumber: z.string().describe("Number of the source estimate."),
        estimateSeriesName: z
          .string()
          .optional()
          .describe("Series of the source estimate. Falls back to SMARTBILL_ESTIMATE_SERIES."),
        seriesName: z.string().optional().describe("Invoice series to issue into."),
        companyVatCode: z.string().optional(),
        issueDate: isoDate.optional(),
        dueDate: isoDate.optional(),
        isDraft: z.boolean().optional(),
        mentions: z.string().optional(),
        observations: z.string().optional(),
        sendEmail: z.boolean().optional().describe("Email the invoice to the client on issue."),
      },
      annotations: { title: "Create invoice from estimate", readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const body = omitUndefined({
        companyVatCode: args.companyVatCode ?? config.companyVatCode,
        seriesName: series(args.seriesName),
        issueDate: args.issueDate,
        dueDate: args.dueDate,
        isDraft: args.isDraft,
        mentions: args.mentions,
        observations: args.observations,
        sendEmail: args.sendEmail,
        useEstimateDetails: true,
        estimate: {
          seriesName: resolveSeries(
            args.estimateSeriesName,
            config.defaultEstimateSeries,
            "SMARTBILL_ESTIMATE_SERIES",
          ),
          number: args.estimateNumber,
        },
      });
      return jsonResult(await client.requestJson({ method: "POST", path: "/invoice", body }));
    },
  );

  server.registerTool(
    "create_reverse_invoice",
    {
      title: "Create reverse (storno) invoice",
      description:
        "Issue a storno invoice that reverses an existing invoice in full. The reversal is issued into the same series.",
      inputSchema: {
        ...invoiceRefSchema,
        issueDate: isoDate.optional().describe("Issue date of the storno invoice (YYYY-MM-DD)."),
      },
      annotations: { title: "Create reverse invoice", readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const body = omitUndefined({
        companyVatCode: args.companyVatCode ?? config.companyVatCode,
        seriesName: series(args.seriesName),
        number: args.number,
        issueDate: args.issueDate,
      });
      return jsonResult(await client.requestJson({ method: "POST", path: "/invoice/reverse", body }));
    },
  );

  server.registerTool(
    "get_invoice_pdf",
    {
      title: "Download invoice PDF",
      description:
        "Download the PDF of an invoice. By default the file is written to the configured download directory and the path is returned.",
      inputSchema: { ...invoiceRefSchema, ...documentDeliverySchema },
      annotations: { title: "Download invoice PDF", readOnlyHint: true },
    },
    async (args) => {
      const seriesName = series(args.seriesName);
      const binary = await client.requestBinary({
        method: "GET",
        path: "/invoice/pdf",
        query: {
          cif: args.companyVatCode ?? config.companyVatCode,
          seriesname: seriesName,
          number: args.number,
        },
      });
      return deliverPdf(binary, `${seriesName}${args.number}.pdf`, config, args.as);
    },
  );

  server.registerTool(
    "get_invoice_payment_status",
    {
      title: "Get invoice payment status",
      description:
        "Check how much of an invoice has been collected. Returns the invoice total, the paid and unpaid amounts and a `paid` flag.",
      inputSchema: invoiceRefSchema,
      annotations: { title: "Get invoice payment status", readOnlyHint: true },
    },
    async (args) =>
      jsonResult(
        await client.requestJson({
          method: "GET",
          path: "/invoice/paymentstatus",
          query: {
            cif: args.companyVatCode ?? config.companyVatCode,
            seriesname: series(args.seriesName),
            number: args.number,
          },
        }),
      ),
  );

  server.registerTool(
    "cancel_invoice",
    {
      title: "Cancel invoice",
      description:
        "Mark an invoice as cancelled (anulata). The document keeps its number and can be brought back with restore_invoice.",
      inputSchema: invoiceRefSchema,
      annotations: { title: "Cancel invoice", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args) =>
      jsonResult(
        await client.requestJson({
          method: "PUT",
          path: "/invoice/cancel",
          query: {
            cif: args.companyVatCode ?? config.companyVatCode,
            seriesname: series(args.seriesName),
            number: args.number,
          },
        }),
      ),
  );

  server.registerTool(
    "restore_invoice",
    {
      title: "Restore cancelled invoice",
      description: "Undo a cancellation and put the invoice back into its normal state.",
      inputSchema: invoiceRefSchema,
      annotations: { title: "Restore invoice", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) =>
      jsonResult(
        await client.requestJson({
          method: "PUT",
          path: "/invoice/restore",
          query: {
            cif: args.companyVatCode ?? config.companyVatCode,
            seriesname: series(args.seriesName),
            number: args.number,
          },
        }),
      ),
  );

  server.registerTool(
    "delete_invoice",
    {
      title: "Delete invoice",
      description:
        "Permanently delete an invoice. Only the last invoice in a series can be deleted; use cancel_invoice for older ones.",
      inputSchema: invoiceRefSchema,
      annotations: { title: "Delete invoice", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args) =>
      jsonResult(
        await client.requestJson({
          method: "DELETE",
          path: "/invoice",
          query: {
            cif: args.companyVatCode ?? config.companyVatCode,
            seriesname: series(args.seriesName),
            number: args.number,
          },
        }),
      ),
  );
}
