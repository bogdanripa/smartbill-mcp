import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildDocumentBody,
  deliverPdf,
  documentBodySchema,
  documentDeliverySchema,
  jsonResult,
  resolveSeries,
  type ToolContext,
} from "./shared.js";

const ESTIMATE_SERIES_ENV = "SMARTBILL_ESTIMATE_SERIES";

const estimateRefSchema = {
  number: z
    .string()
    .describe(
      "Estimate number as printed on the document, leading zeros included — '0021', not '21'. " +
        "An unpadded number is reported as not found.",
    ),
  seriesName: z.string().optional().describe("Estimate series. Falls back to the configured default."),
  companyVatCode: z.string().optional().describe("Issuing company CIF. Falls back to SMARTBILL_VAT_CODE."),
};

export function registerEstimateTools(server: McpServer, ctx: ToolContext): void {
  const { client, config } = ctx;

  const series = (explicit?: string) =>
    resolveSeries(explicit, config.defaultEstimateSeries, ESTIMATE_SERIES_ENV);

  server.registerTool(
    "create_estimate",
    {
      title: "Create estimate (proforma)",
      description:
        "Issue a proforma (estimate) — a quote or payment request that is not yet a fiscal invoice. Returns " +
        "{ series, number, url }.\n\n" +
        "Use this when the customer needs something to approve or to pay against before being invoiced, or when " +
        "the user asks for a quote, an offer or a proforma. Use create_invoice instead when the sale is final and " +
        "a fiscal document is what's wanted.\n\n" +
        "Once the customer accepts, turn it into an invoice with create_invoice_from_estimate rather than building " +
        "the invoice by hand. As with invoices, call list_taxes for valid VAT rates.",
      inputSchema: documentBodySchema,
      annotations: { title: "Create estimate", readOnlyHint: false, destructiveHint: false },
    },
    async (args) =>
      jsonResult(
        await client.requestJson({
          method: "POST",
          path: "/estimate",
          body: buildDocumentBody(
            args,
            series(args.seriesName),
            args.companyVatCode ?? config.companyVatCode,
          ),
        }),
      ),
  );

  server.registerTool(
    "get_estimate_pdf",
    {
      title: "Read estimate PDF",
      description:
        "Read an already-issued proforma. Defaults to returning its TEXT, which is the only way to see the " +
        "proforma's date, client or line items — no SmartBill endpoint reports those. Read-only.\n\n" +
        "The other `as` modes are not ways to hand a document to the user: 'file' writes to the server's own disk, " +
        "unreachable over HTTP, and 'base64' returns bytes you cannot decode. To get the document to someone, use " +
        "send_document_email.",
      inputSchema: { ...estimateRefSchema, ...documentDeliverySchema },
      annotations: { title: "Read estimate PDF", readOnlyHint: true },
    },
    async (args) => {
      const seriesName = series(args.seriesName);
      const binary = await client.requestBinary({
        method: "GET",
        path: "/estimate/pdf",
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
    "get_estimate_invoices",
    {
      title: "List invoices issued from an estimate",
      description:
        "Check whether a proforma has already been invoiced, and which invoices came out of it. Read-only.\n\n" +
        "Call this before create_invoice_from_estimate to avoid double-invoicing the same proforma, and to answer " +
        "questions like 'did we ever bill that quote?'. An empty result means the proforma is still open.",
      inputSchema: estimateRefSchema,
      annotations: { title: "List invoices from estimate", readOnlyHint: true },
    },
    async (args) =>
      jsonResult(
        await client.requestJson({
          method: "GET",
          path: "/estimate/invoices",
          query: {
            cif: args.companyVatCode ?? config.companyVatCode,
            seriesname: series(args.seriesName),
            number: args.number,
          },
        }),
      ),
  );

  server.registerTool(
    "cancel_estimate",
    {
      title: "Cancel estimate",
      description:
        "Void a proforma. It stays in SmartBill, keeps its number and is marked cancelled, so the series has no " +
        "gap. Reversible with restore_estimate.\n\n" +
        "Use this when a quote is withdrawn or the customer declines. Use delete_estimate only if it is the last " +
        "one in its series and should disappear entirely.",
      inputSchema: estimateRefSchema,
      annotations: { title: "Cancel estimate", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args) =>
      jsonResult(
        await client.requestJson({
          method: "PUT",
          path: "/estimate/cancel",
          query: {
            cif: args.companyVatCode ?? config.companyVatCode,
            seriesname: series(args.seriesName),
            number: args.number,
          },
        }),
      ),
  );

  server.registerTool(
    "restore_estimate",
    {
      title: "Restore cancelled estimate",
      description:
        "Undo cancel_estimate and put a cancelled proforma back into its normal state.\n\n" +
        "Use this when a quote was voided by mistake and is live again. It cannot bring back a proforma that was " +
        "deleted — deletion has no undo.",
      inputSchema: estimateRefSchema,
      annotations: { title: "Restore estimate", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) =>
      jsonResult(
        await client.requestJson({
          method: "PUT",
          path: "/estimate/restore",
          query: {
            cif: args.companyVatCode ?? config.companyVatCode,
            seriesname: series(args.seriesName),
            number: args.number,
          },
        }),
      ),
  );

  server.registerTool(
    "delete_estimate",
    {
      title: "Delete estimate",
      description:
        "Permanently remove a proforma, freeing its number for reuse. Irreversible — there is no restore.\n\n" +
        "SmartBill only allows this for the LAST proforma in a series and rejects it for any earlier one; use " +
        "cancel_estimate for those. Ask the user to confirm, and prefer cancel_estimate when unsure.",
      inputSchema: estimateRefSchema,
      annotations: { title: "Delete estimate", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args) =>
      jsonResult(
        await client.requestJson({
          method: "DELETE",
          path: "/estimate",
          query: {
            cif: args.companyVatCode ?? config.companyVatCode,
            seriesname: series(args.seriesName),
            number: args.number,
          },
        }),
      ),
  );
}
