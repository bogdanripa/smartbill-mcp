import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { clientSchema, DELETABLE_PAYMENT_TYPES, isoDate, omitUndefined, PAYMENT_TYPES } from "../schemas.js";
import { jsonResult, resolveSeries, type ToolContext } from "./shared.js";

const RECEIPT_SERIES_ENV = "SMARTBILL_RECEIPT_SERIES";

export function registerPaymentTools(server: McpServer, ctx: ToolContext): void {
  const { client, config } = ctx;

  const receiptSeries = (explicit?: string) =>
    resolveSeries(explicit, config.defaultReceiptSeries, RECEIPT_SERIES_ENV);

  server.registerTool(
    "create_payment",
    {
      title: "Record a payment",
      description:
        "Record a collection (incasare). Set `invoices` to settle specific invoices, or leave it empty for a standalone payment. " +
        "`seriesName` is only needed for type 'Chitanta', where it is the receipt series.",
      inputSchema: {
        client: clientSchema.describe("The client the payment comes from."),
        value: z.number().describe("Amount collected."),
        type: z.enum(PAYMENT_TYPES).describe("Payment method."),
        issueDate: isoDate.optional().describe("Payment date (YYYY-MM-DD). Defaults to today at SmartBill."),
        seriesName: z.string().optional().describe("Receipt series, used when type is 'Chitanta'."),
        companyVatCode: z.string().optional().describe("Issuing company CIF. Falls back to SMARTBILL_VAT_CODE."),
        isCash: z.boolean().optional().describe("True for cash collection. Default false."),
        currency: z.string().optional().describe("Payment currency. Default RON."),
        exchangeRate: z.number().optional(),
        language: z.string().optional().describe("Document language. Default RO."),
        precision: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
        text: z.string().optional().describe("Text printed on the receipt, e.g. 'Contravaloare factura FF 120'."),
        translatedText: z.string().optional(),
        observations: z.string().optional().describe("Internal note."),
        isDraft: z.boolean().optional(),
        invoices: z
          .array(
            z.object({
              number: z.string().describe("Invoice number."),
              seriesName: z.string().optional().describe("Invoice series. Falls back to SMARTBILL_INVOICE_SERIES."),
            }),
          )
          .optional()
          .describe("Invoices this payment settles."),
        useInvoiceDetails: z
          .boolean()
          .optional()
          .describe("Take the client details from the referenced invoice instead of the `client` argument."),
      },
      annotations: { title: "Record a payment", readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const invoicesList = args.invoices?.map((invoice) => ({
        seriesName: resolveSeries(invoice.seriesName, config.defaultInvoiceSeries, "SMARTBILL_INVOICE_SERIES"),
        number: invoice.number,
      }));

      const body = omitUndefined({
        companyVatCode: args.companyVatCode ?? config.companyVatCode,
        client: omitUndefined(args.client),
        issueDate: args.issueDate,
        // Only receipts live in a series; sending one for other types is rejected.
        seriesName: args.type === "Chitanta" ? receiptSeries(args.seriesName) : args.seriesName,
        language: args.language,
        currency: args.currency,
        exchangeRate: args.exchangeRate,
        precision: args.precision,
        value: args.value,
        text: args.text,
        translatedText: args.translatedText,
        isDraft: args.isDraft,
        type: args.type,
        isCash: args.isCash,
        observations: args.observations,
        useInvoiceDetails: args.useInvoiceDetails,
        invoicesList,
      });

      return jsonResult(await client.requestJson({ method: "POST", path: "/payment", body }));
    },
  );

  server.registerTool(
    "cancel_payment",
    {
      title: "Cancel receipt",
      description: "Mark a receipt (chitanta) as cancelled without removing it.",
      inputSchema: {
        number: z.string().describe("Receipt number."),
        seriesName: z.string().optional().describe("Receipt series. Falls back to SMARTBILL_RECEIPT_SERIES."),
        companyVatCode: z.string().optional(),
      },
      annotations: { title: "Cancel receipt", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args) =>
      jsonResult(
        await client.requestJson({
          method: "PUT",
          path: "/payment/cancel",
          query: {
            cif: args.companyVatCode ?? config.companyVatCode,
            seriesname: receiptSeries(args.seriesName),
            number: args.number,
          },
        }),
      ),
  );

  server.registerTool(
    "delete_receipt",
    {
      title: "Delete receipt",
      description: "Permanently delete a receipt (chitanta) identified by its series and number.",
      inputSchema: {
        number: z.string().describe("Receipt number."),
        seriesName: z.string().optional().describe("Receipt series. Falls back to SMARTBILL_RECEIPT_SERIES."),
        companyVatCode: z.string().optional(),
      },
      annotations: { title: "Delete receipt", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args) =>
      jsonResult(
        await client.requestJson({
          method: "DELETE",
          path: "/payment/chitanta",
          query: {
            cif: args.companyVatCode ?? config.companyVatCode,
            seriesname: receiptSeries(args.seriesName),
            number: args.number,
          },
        }),
      ),
  );

  server.registerTool(
    "delete_payment",
    {
      title: "Delete non-receipt payment",
      description:
        "Delete a collection that is not a receipt (card, bank transfer, promissory note, ...). " +
        "Identify it either by the invoice it settles (invoiceSeries + invoiceNumber) or by date, value and client.",
      inputSchema: {
        paymentType: z.enum(DELETABLE_PAYMENT_TYPES).describe("Type of the payment to delete."),
        invoiceSeries: z.string().optional().describe("Series of the settled invoice."),
        invoiceNumber: z.string().optional().describe("Number of the settled invoice."),
        paymentDate: isoDate.optional().describe("Payment date (YYYY-MM-DD). Not needed when the invoice is known."),
        paymentValue: z.number().optional().describe("Payment amount. Not needed when the invoice is known."),
        clientName: z.string().optional().describe("Client name. Not needed when the invoice is known."),
        clientCif: z.string().optional().describe("Client CIF. Not needed when the invoice is known."),
        companyVatCode: z.string().optional(),
      },
      annotations: { title: "Delete payment", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args) => {
      const hasInvoice = Boolean(args.invoiceNumber);
      const hasDetails = Boolean(args.paymentDate && args.paymentValue !== undefined);
      if (!hasInvoice && !hasDetails) {
        throw new Error(
          "Give either invoiceNumber (with invoiceSeries) or both paymentDate and paymentValue so the payment can be identified.",
        );
      }

      return jsonResult(
        await client.requestJson({
          method: "DELETE",
          path: "/payment",
          query: {
            cif: args.companyVatCode ?? config.companyVatCode,
            paymentType: args.paymentType,
            paymentDate: args.paymentDate,
            paymentValue: args.paymentValue,
            clientName: args.clientName,
            clientCif: args.clientCif,
            invoiceSeries: args.invoiceNumber
              ? resolveSeries(args.invoiceSeries, config.defaultInvoiceSeries, "SMARTBILL_INVOICE_SERIES")
              : args.invoiceSeries,
            invoiceNumber: args.invoiceNumber,
          },
        }),
      );
    },
  );

  server.registerTool(
    "get_fiscal_receipt_text",
    {
      title: "Get fiscal receipt text",
      description:
        "Fetch the printable text of a fiscal receipt (bon fiscal) by its SmartBill id. The base64 payload is decoded for you.",
      inputSchema: {
        id: z.string().describe("SmartBill id of the fiscal receipt."),
        companyVatCode: z.string().optional(),
      },
      annotations: { title: "Get fiscal receipt text", readOnlyHint: true },
    },
    async (args) => {
      const response = (await client.requestJson({
        method: "GET",
        path: "/payment/text",
        query: { cif: args.companyVatCode ?? config.companyVatCode, id: args.id },
      })) as Record<string, unknown>;

      const encoded = response?.message;
      const text =
        typeof encoded === "string" ? Buffer.from(encoded, "base64").toString("utf8") : undefined;

      return jsonResult({ ...response, message: text ?? encoded });
    },
  );
}
