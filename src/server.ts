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

const INSTRUCTIONS = `Tools for the SmartBill Cloud API (Romanian invoicing).

Documents are identified by a series plus a number, e.g. series "FF" number "120".
Series can be omitted when a default is configured; call list_series to discover
the ones this account has. Call list_taxes to get valid taxName / taxPercentage
values before building invoice lines.

Issuing a document is not reversible from the API in the general case: only the
last document in a series can be deleted, older ones can only be cancelled
(cancel_invoice) or reversed with a storno invoice (create_reverse_invoice).
Confirm amounts and the client with the user before issuing anything final, and
prefer isDraft: true when the details are not yet settled.`;

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
