import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SmartBillClient } from "./client.js";
import type { SmartBillConfig } from "./config.js";
import { registerAccountTools } from "./tools/account.js";
import { registerEstimateTools } from "./tools/estimates.js";
import { registerInvoiceTools } from "./tools/invoices.js";
import { registerPaymentTools } from "./tools/payments.js";
import type { ToolContext } from "./tools/shared.js";
import { registerPortalTools } from "./portal/tools.js";
import type { PortalService } from "./portal/service.js";

export const SERVER_NAME = "smartbill-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * The commit this image was built from, baked in at build time.
 *
 * During a redeploy the outgoing container is still serving, so a health check
 * that only asks "did something answer 200?" is satisfied by the container being
 * replaced. Reporting the build lets a caller wait for the one it just built
 * instead, and tells anyone looking at a running box what is actually on it.
 * "dev" outside a built image.
 */
export const BUILD_SHA = process.env.BUILD_SHA?.trim() || "dev";

/**
 * The limitations paragraph depends on whether the portal report tools are
 * present. Without them the public API genuinely cannot search or list; with
 * them, those questions ARE answerable — so the instructions must not tell the
 * model to give up.
 */
const LIMITS_PUBLIC_ONLY = `Documents can only be fetched by series and number. There is no search, no date
range and no per-client lookup, and SmartBill exposes no customer list at all —
clients are only ever written, as part of a document. So "all invoices for client
ABC", "everything issued last month" and "list my customers" cannot be answered
here. Say that plainly instead of guessing numbers or probing series one at a
time; the account is rate limited and will start refusing requests. list_series,
list_taxes and list_stocks are the only listings that exist.`;

const LIMITS_WITH_PORTAL = `The public API tools below fetch a document only by series and number — they
cannot search or list. But this server also has portal report tools that read
the SmartBill web account and DO answer those questions: list_clients and
get_client_details (the customer roster), get_client_statement and
get_client_ledger (every document for one client over a date range, by CIF or
name), list_receivables and list_client_balances (who owes what, with status and
aging), list_payments (collections received) and list_product_sales. Use those
for "all invoices for client ABC", "who owes me money", "list my customers",
"what did we collect or sell". They return printed document numbers you can feed
back into the public-API tools for payment status or the PDF.`;

function buildInstructions(limits: string): string {
  return `Tools for SmartBill Cloud, the Romanian invoicing service. They act on one real
company's books: everything issued here is a live fiscal document, not a sandbox.

Documents are identified by a series plus a number — series "FF", number "120",
usually written "FF 120". A series can be omitted when the server has a default
configured; otherwise call list_series to see what this account actually has.
Never invent a series name or a VAT rate.

Numbers keep their leading zeros. It is the number as printed on the document,
not its integer value: invoice 159 in series "GNZ-" is "0159", and "159" comes
back as "Factura nu a fost gasita" — which reads like the document is missing
when it is only mis-formatted. Do not report a document as non-existent on the
strength of that error alone; check the padding first. list_series returns
nextNumber as a plain integer, so pad it back out before using it, and do not
assume nextNumber minus one exists — deleting the last document in a series
leaves the counter where it was.

Amounts come back without a currency. get_invoice_payment_status returns bare
numbers in whatever currency the invoice was issued in, and SmartBill does not
report which — an invoice in EUR looks exactly like one in RON. Never attach a
currency you have not verified. Give the figure unqualified, or read the
currency off the document with get_invoice_pdf first.

Almost everything about a document lives only inside its PDF. No endpoint returns
an invoice's issue date, its client, or its line items — get_invoice_payment_status
gives amounts and a paid flag, and that is all. To answer "when was this issued?"
or "who was it for?", call get_invoice_pdf with as: "text", which returns the
document's text. Do not conclude the information is unavailable.

The other delivery modes are not ways to hand a file to anyone, and offering them
wastes a turn. "file" writes to this server's own disk — over HTTP that is a
different machine with no route to serve it back. "base64" returns bytes you
cannot decode or reassemble into a document. When the user wants the file itself,
send_document_email mails it from SmartBill, or point them at SmartBill Cloud.

${limits}

Three document kinds, easy to confuse:
- invoice (factura) — the fiscal document. create_invoice.
- estimate (proforma) — a quote or payment request, not yet fiscal. create_estimate.
  Once accepted, convert it with create_invoice_from_estimate so the two documents
  stay linked.
- payment (incasare) — money received. create_payment, optionally settling
  specific invoices.

Before issuing anything, call list_taxes for valid taxName / taxPercentage values
and list_series if the series is unknown. Both are cheap and read-only.

Undoing is asymmetric and worth getting right: only the LAST document in a series
can be deleted. Anything earlier can be cancelled (cancel_invoice, reversible) or
reversed with a storno document (create_reverse_invoice, which is what accounting
usually wants). Deleting is irreversible.

Confirm the client, the amounts and the VAT rate with the user before issuing a
final document, emailing a customer, or deleting anything. Prefer isDraft: true
while details are still unsettled — a draft can be edited or discarded.`;
}

export interface CreateServerOptions {
  fetchImpl?: typeof fetch;
  /** When set, the session-based portal report tools are registered too. */
  portal?: PortalService;
}

export function createServer(config: SmartBillConfig, options: CreateServerOptions = {}): McpServer {
  const { fetchImpl, portal } = options;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: buildInstructions(portal ? LIMITS_WITH_PORTAL : LIMITS_PUBLIC_ONLY) },
  );

  const ctx: ToolContext = { client: new SmartBillClient(config, fetchImpl), config };

  registerInvoiceTools(server, ctx);
  registerEstimateTools(server, ctx);
  registerPaymentTools(server, ctx);
  registerAccountTools(server, ctx);

  if (portal) registerPortalTools(server, { service: portal, config });

  return server;
}
