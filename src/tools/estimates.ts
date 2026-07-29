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
  number: z.string().describe("Estimate number, without the series prefix."),
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
        "Issue a proforma invoice. Returns the series, number and SmartBill URL. " +
        "An estimate can later be turned into an invoice with create_invoice_from_estimate.",
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
      title: "Download estimate PDF",
      description:
        "Download the PDF of an estimate. By default the file is written to the configured download directory and the path is returned.",
      inputSchema: { ...estimateRefSchema, ...documentDeliverySchema },
      annotations: { title: "Download estimate PDF", readOnlyHint: true },
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
        "Check whether an estimate has already been invoiced, and which invoices were issued from it.",
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
      description: "Mark an estimate as cancelled. It can be brought back with restore_estimate.",
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
      description: "Undo a cancellation and put the estimate back into its normal state.",
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
        "Permanently delete an estimate. Only the last estimate in a series can be deleted; use cancel_estimate for older ones.",
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
