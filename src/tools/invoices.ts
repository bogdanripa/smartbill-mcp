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
  number: z
    .string()
    .describe(
      "Invoice number as printed on the document, leading zeros included — '0159', not '159'. " +
        "An unpadded number is reported as not found.",
    ),
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
        "Issue a new invoice (factura) in SmartBill for a normal sale. Returns { series, number, url }, where url " +
        "links to the document in SmartBill Cloud.\n\n" +
        "Before calling: use list_taxes to get valid taxName/taxPercentage values rather than guessing a VAT rate, " +
        "and list_series if you do not know which series to issue into.\n\n" +
        "Do not use this to invoice an existing proforma — use create_invoice_from_estimate, which links the two " +
        "documents. Do not use it to reverse an invoice — use create_reverse_invoice.\n\n" +
        "An issued invoice is a fiscal document that generally cannot be deleted afterwards. Confirm the client, " +
        "the amounts and the VAT rate with the user before calling, and pass isDraft: true while details are still " +
        "unsettled — a draft can be edited or discarded in SmartBill.",
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
        "Issue an invoice from a proforma the customer has accepted. Returns { series, number, url }.\n\n" +
        "Prefer this over create_invoice whenever a proforma exists: it links the two documents, so the proforma " +
        "is reported as invoiced by get_estimate_invoices. Rebuilding the same invoice by hand leaves the proforma " +
        "looking unbilled.\n\n" +
        "The client and the line items are copied from the proforma — do not re-send them. `seriesName` is the " +
        "invoice series to issue into; `estimateSeriesName` and `estimateNumber` identify the source proforma.",
      inputSchema: {
        estimateNumber: z.string().describe("Number of the source estimate."),
        estimateSeriesName: z
          .string()
          .optional()
          .describe("Series of the source estimate. Falls back to SMARTBILL_ESTIMATE_SERIES."),
        seriesName: z.string().optional().describe("Invoice series to issue into."),
        companyVatCode: z.string().optional().describe("Issuing company CIF. Falls back to SMARTBILL_VAT_CODE."),
        issueDate: isoDate.optional().describe("Invoice issue date (YYYY-MM-DD). Defaults to today at SmartBill."),
        dueDate: isoDate.optional().describe("Payment due date (YYYY-MM-DD)."),
        isDraft: z.boolean().optional().describe("Issue as a draft instead of a final invoice."),
        mentions: z.string().optional().describe("Free text printed on the invoice."),
        observations: z.string().optional().describe("Internal note; not printed on the invoice."),
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
        "Issue a storno invoice that reverses an existing invoice in full, into the same series. This is the " +
        "accounting-visible way to undo an invoice: both documents remain, and they cancel out.\n\n" +
        "Use this when an invoice is too old to delete and the reversal has to appear in the books. Use " +
        "cancel_invoice instead when the invoice was issued in error and simply needs to be voided. For a partial " +
        "correction, issue a new invoice with negative quantities rather than reversing the whole document.\n\n" +
        "This creates a new fiscal document — confirm with the user before calling.",
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
      title: "Read invoice PDF",
      description:
        "Read an already-issued invoice. Defaults to returning its TEXT, which is the only way to see an " +
        "invoice's issue date, client, line items or currency — no SmartBill endpoint reports those, they exist " +
        "only inside the document. Read-only.\n\n" +
        "Use this whenever you need any detail beyond the amounts that get_invoice_payment_status returns, and to " +
        "establish an invoice's currency before quoting a figure.\n\n" +
        "The other `as` modes are not ways to hand a document to the user. 'file' writes to the server's own disk, " +
        "which over HTTP is a different machine with no route to serve it back. 'base64' returns bytes you cannot " +
        "decode or reassemble — never offer it as a means of delivering a PDF. If the user wants the actual file, " +
        "send_document_email mails it from SmartBill, or point them at SmartBill Cloud.",
      inputSchema: { ...invoiceRefSchema, ...documentDeliverySchema },
      annotations: { title: "Read invoice PDF", readOnlyHint: true },
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
        "Answer whether an invoice has been paid, and how much of it. Returns invoiceTotalAmount, paidAmount, " +
        "unpaidAmount and a `paid` flag. Read-only — this reports on collections, it does not record one.\n\n" +
        "The amounts carry NO currency. They are in whatever currency the invoice was issued in, and SmartBill does " +
        "not report which — an invoice issued in EUR returns the EUR figure, indistinguishable from a RON one. Do " +
        "not append RON, or any currency, to these numbers on your own authority: state the amount unqualified, or " +
        "call get_invoice_pdf to read the currency off the document first. Saying '1250 RON' for a 1250 EUR invoice " +
        "misstates it several-fold.\n\n" +
        "Use it for questions like 'has invoice FF 120 been paid?' or 'how much does this client still owe on it?', " +
        "and to confirm the effect after calling create_payment. To record money received, use create_payment.",
      inputSchema: invoiceRefSchema,
      annotations: { title: "Get invoice payment status", readOnlyHint: true },
    },
    async (args) => {
      const response = (await client.requestJson({
        method: "GET",
        path: "/invoice/paymentstatus",
        query: {
          cif: args.companyVatCode ?? config.companyVatCode,
          seriesname: series(args.seriesName),
          number: args.number,
        },
      })) as Record<string, unknown>;

      // The amounts are in the invoice's own currency and the endpoint never
      // says which. Left bare, a number next to a Romanian invoicing service
      // reads as RON — and did, for an invoice issued in EUR. Say so in the
      // payload rather than only in the description, so it sits next to the
      // figure it qualifies.
      return jsonResult({
        ...response,
        currency: "unknown",
        currencyNote:
          "Amounts are in the currency the invoice was issued in. SmartBill does not report it here — do not " +
          "assume RON. Use get_invoice_pdf to read the currency off the document.",
      });
    },
  );

  server.registerTool(
    "cancel_invoice",
    {
      title: "Cancel invoice",
      description:
        "Void an invoice (anulare). The document stays in SmartBill, keeps its number and is marked cancelled, so " +
        "the series has no gap. Reversible with restore_invoice.\n\n" +
        "Use this when an invoice was issued in error. Use delete_invoice only if it is the last one in its series " +
        "and should vanish entirely; use create_reverse_invoice when the undo has to appear in the accounts as a " +
        "storno document.\n\n" +
        "Confirm with the user before calling — this changes the status of a real fiscal document.",
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
      description:
        "Undo cancel_invoice and put a cancelled invoice back into its normal, valid state.\n\n" +
        "Use this when an invoice was voided by mistake and should count again. It has no effect on an invoice " +
        "that was never cancelled, and it cannot bring back one that was deleted — deletion has no undo.",
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
        "Permanently remove an invoice, freeing its number for reuse. Irreversible — there is no restore.\n\n" +
        "SmartBill only allows this for the LAST invoice in a series and rejects it for any earlier one. For those, " +
        "use cancel_invoice to void it or create_reverse_invoice to storno it.\n\n" +
        "Destroys a fiscal document: ask the user to confirm explicitly, and prefer cancel_invoice when unsure.",
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
