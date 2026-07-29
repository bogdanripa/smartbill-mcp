import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SmartBillClient } from "./client.js";
import type { SmartBillConfig } from "./config.js";
import { registerAccountTools } from "./tools/account.js";
import { registerEstimateTools } from "./tools/estimates.js";
import { registerInvoiceTools } from "./tools/invoices.js";
import { registerPaymentTools } from "./tools/payments.js";
import type { ToolContext } from "./tools/shared.js";

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

const INSTRUCTIONS = `Tools for SmartBill Cloud, the Romanian invoicing service. They act on one real
company's books: everything issued here is a live fiscal document, not a sandbox.

Documents are identified by a series plus a number — series "FF", number "120",
usually written "FF 120". A series can be omitted when the server has a default
configured; otherwise call list_series to see what this account actually has.
Never invent a series name or a VAT rate.

Documents can only be fetched by series and number. There is no search, no date
range and no per-client lookup, and SmartBill exposes no customer list at all —
clients are only ever written, as part of a document. So "all invoices for client
ABC", "everything issued last month" and "list my customers" cannot be answered
here. Say that plainly instead of guessing numbers or probing series one at a
time; the account is rate limited and will start refusing requests. list_series,
list_taxes and list_stocks are the only listings that exist.

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

export function createServer(config: SmartBillConfig, fetchImpl?: typeof fetch): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  const ctx: ToolContext = { client: new SmartBillClient(config, fetchImpl), config };

  registerInvoiceTools(server, ctx);
  registerEstimateTools(server, ctx);
  registerPaymentTools(server, ctx);
  registerAccountTools(server, ctx);

  return server;
}
