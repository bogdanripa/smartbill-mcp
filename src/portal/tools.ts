// The session-based MCP tools — customer roster, statements, receivables,
// collections and product sales — backed by the SmartBill Cloud portal rather
// than the public API. Registered only when a portal service is configured
// (i.e. DATABASE_URL + SMARTBILL_SESSION_KEY are set).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SmartBillConfig } from "../config.js";
import { isoDate } from "../schemas.js";
import { jsonResult, type ToolResult } from "../tools/shared.js";
import type { PortalEndpointName, PortalParams } from "./endpoints.js";
import { ddmmyyyy } from "./endpoints.js";
import { PortalNeedsManualError, type PortalService } from "./service.js";
import { PortalAuthError } from "./session.js";

/** SmartBill's UI wants dd/mm/yyyy; tools accept ISO (YYYY-MM-DD) like the rest of the server. */
function isoToDdmmyyyy(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return undefined;
  return ddmmyyyy(new Date(Number(y), Number(m) - 1, Number(d)));
}

export interface PortalToolContext {
  service: PortalService;
  config: SmartBillConfig;
}

/** Clients per receivables request, and the ceiling on how many pages we walk. */
const RECEIVABLES_PAGE_SIZE = 200;
const RECEIVABLES_MAX_PAGES = 25;

interface ReceivablesPage {
  clients?: unknown[];
  clientsCount?: number;
  [key: string]: unknown;
}

/**
 * Walks every page of the receivables report and merges them into one payload.
 *
 * Exported for tests. `fetchPage` is 1-based, matching the portal.
 *
 * The stop condition is a short page, deliberately not `clientsCount`: on an
 * account where a client holds invoices in two currencies the report emits one
 * row per client *and currency*, so the row count legitimately runs ahead of
 * clientsCount (68 rows against a count of 59 on one of the accounts probed).
 * Treating that number as the expected length would end the walk early on some
 * accounts and loop forever on others.
 */
export async function mergeReceivablePages(
  fetchPage: (page: number, pageSize: number) => Promise<ReceivablesPage>,
  pageSize: number = RECEIVABLES_PAGE_SIZE,
  maxPages: number = RECEIVABLES_MAX_PAGES,
): Promise<ReceivablesPage> {
  let first: ReceivablesPage | undefined;
  const clients: unknown[] = [];
  let page = 1;

  for (; page <= maxPages; page++) {
    const data = await fetchPage(page, pageSize);
    first ??= data;
    const batch = Array.isArray(data.clients) ? data.clients : [];
    clients.push(...batch);
    if (batch.length < pageSize) break; // a short page is the last page
  }

  const merged: ReceivablesPage = { ...(first ?? {}), clients };
  if (page > maxPages) {
    // Never return a short list that reads as the whole report.
    merged.truncated = true;
    merged.truncationNote =
      `Stopped after ${maxPages} pages of ${pageSize} clients. Narrow the report with ` +
      `from/to or clientName to see the rest.`;
  }
  return merged;
}

export function registerPortalTools(server: McpServer, { service, config }: PortalToolContext): void {
  const call = (endpoint: PortalEndpointName, params: PortalParams): Promise<unknown> =>
    service.call(config.username, config.token, config.companyVatCode, endpoint, params);

  /** Shapes portal auth failures into a clean, actionable result instead of a stack trace. */
  const guard = async (produce: () => Promise<unknown>): Promise<ToolResult> => {
    try {
      return jsonResult(await produce());
    } catch (error) {
      if (error instanceof PortalNeedsManualError || error instanceof PortalAuthError) {
        return jsonResult({ error: error.message, action: "Re-enter your SmartBill email and password on the setup page." });
      }
      throw error;
    }
  };

  const run = (endpoint: PortalEndpointName, params: PortalParams): Promise<ToolResult> =>
    guard(() => call(endpoint, params));

  server.registerTool(
    "list_clients",
    {
      title: "List customers",
      description:
        "List customers from the SmartBill account (the nomenclator), optionally filtered by a name substring. " +
        "This is the customer roster the public API cannot provide.\n\n" +
        "Use it to find a client's exact name and CIF before calling the statement/ledger/balance tools, or to " +
        "answer 'who are my customers?'. Each row carries name, CIF (empty for individuals), email and phone.",
      inputSchema: {
        search: z.string().optional().describe("Case-insensitive substring of the client name. Omit to list all."),
        limit: z.number().int().positive().max(500).optional().describe("Max rows to return. Default 50."),
      },
      annotations: { title: "List customers", readOnlyHint: true },
    },
    (args) => run("clients", { search: args.search, length: args.limit }),
  );

  server.registerTool(
    "get_client_details",
    {
      title: "Get customer details",
      description:
        "Fetch a customer's full record — address, county/country, registration number, email, IBAN/bank, VAT-payer " +
        "status — by name and/or CIF. Read-only.\n\n" +
        "Give the CIF when you have it (most reliable); otherwise the exact name. Use list_clients first if unsure.",
      inputSchema: {
        clientName: z.string().optional().describe("Exact client name."),
        cif: z.string().optional().describe("Client CIF (with or without the country prefix)."),
      },
      annotations: { title: "Get customer details", readOnlyHint: true },
    },
    (args) => {
      if (!args.clientName && !args.cif) {
        return Promise.resolve(jsonResult({ error: "Provide clientName and/or cif." }));
      }
      return run("clientDetails", { client: args.clientName, cif: args.cif });
    },
  );

  server.registerTool(
    "list_receivables",
    {
      title: "List unpaid invoices (receivables)",
      description:
        "The receivables/aging report: every unpaid invoice grouped by client, each with its status " +
        "('in termen' = within term, 'termen depasit' = overdue), days past due, series+number, value and " +
        "currency, plus per-client and per-currency totals. Read-only.\n\n" +
        "This is how to answer 'who owes me money?', 'what is overdue?' and 'how much is outstanding?' — none of " +
        "which the public API can do. Narrow with a date window or a client name if needed.\n\n" +
        "Every client is returned: the report is paged internally and the pages are merged, so there is no need " +
        "to re-query client by client. `clientsCount` counts distinct clients and can differ from the length of " +
        "`clients` (a client billed in two currencies gets a row per currency) — it is not a completeness check. " +
        "If the report is ever cut short, the result says so in `truncated`.",
      inputSchema: {
        from: isoDate.optional().describe("Start of the issue-date window (YYYY-MM-DD). Defaults to Jan 1 this year."),
        to: isoDate.optional().describe("End of the window (YYYY-MM-DD). Defaults to today."),
        clientName: z.string().optional().describe("Restrict to one client by name."),
      },
      annotations: { title: "List receivables", readOnlyHint: true },
    },
    (args) =>
      guard(() =>
        mergeReceivablePages((page, length) =>
          call("receivables", {
            from: isoToDdmmyyyy(args.from),
            to: isoToDdmmyyyy(args.to),
            client: args.clientName,
            length,
            page,
          }) as Promise<ReceivablesPage>,
        ),
      ),
  );

  server.registerTool(
    "list_client_balances",
    {
      title: "Outstanding balance per client",
      description:
        "Outstanding balance per client as of a date, in each client's currency, with grand totals per currency. " +
        "Read-only. `sold` is the balance on the given date; today's balance is also reported.\n\n" +
        "Use it for 'what does everyone owe right now?' or a single client's balance. Excludes zero-balance " +
        "clients unless asked otherwise.",
      inputSchema: {
        date: isoDate.optional().describe("Balance date (YYYY-MM-DD). Defaults to today."),
        clientName: z.string().optional().describe("Restrict to one client by name."),
        cif: z.string().optional().describe("Restrict to one client by CIF."),
        includeZero: z.boolean().optional().describe("Include clients with a zero balance. Default false."),
      },
      annotations: { title: "Client balances", readOnlyHint: true },
    },
    (args) =>
      run("balances", { date: isoToDdmmyyyy(args.date), client: args.clientName, cif: args.cif, includeZero: args.includeZero }),
  );

  server.registerTool(
    "get_client_statement",
    {
      title: "Client statement (documents over a period)",
      description:
        "Every document issued to one client over a date range — invoices, storno, etc. — each with its printed " +
        "series+number, date, type, value and currency. Read-only. Identify the client by CIF (preferred) or exact " +
        "name.\n\n" +
        "This is the 'all invoices for customer X' history the public API cannot produce. Feed a returned " +
        "series+number into get_invoice_payment_status or get_invoice_pdf for paid status or the PDF.",
      inputSchema: {
        cif: z.string().optional().describe("Client CIF (preferred key)."),
        clientName: z.string().optional().describe("Exact client name (used if no CIF)."),
        from: isoDate.optional().describe("Start (YYYY-MM-DD). Defaults to Jan 1 this year."),
        to: isoDate.optional().describe("End (YYYY-MM-DD). Defaults to today."),
        documentType: z.string().optional().describe("Filter by document type, e.g. 'factura'."),
        documentNumber: z.string().optional().describe("Filter by a specific document number."),
      },
      annotations: { title: "Client statement", readOnlyHint: true },
    },
    (args) => {
      if (!args.cif && !args.clientName) {
        return Promise.resolve(jsonResult({ error: "Provide cif or clientName." }));
      }
      return run("statement", {
        cif: args.cif,
        client: args.clientName,
        from: isoToDdmmyyyy(args.from),
        to: isoToDdmmyyyy(args.to),
        documentType: args.documentType,
        documentNumber: args.documentNumber,
      });
    },
  );

  server.registerTool(
    "get_client_ledger",
    {
      title: "Client ledger (running balance)",
      description:
        "A client's ledger over a period: each document with a running balance, plus an opening-balance row and " +
        "sales-vs-collections totals. Read-only. Identify by CIF (preferred) or exact name.\n\n" +
        "Use this when you need the balance evolution, not just a flat document list (that is get_client_statement).",
      inputSchema: {
        cif: z.string().optional().describe("Client CIF (preferred key)."),
        clientName: z.string().optional().describe("Exact client name (used if no CIF)."),
        from: isoDate.optional().describe("Start (YYYY-MM-DD). Defaults to Jan 1 this year."),
        to: isoDate.optional().describe("End (YYYY-MM-DD). Defaults to today."),
        includeProforme: z.boolean().optional().describe("Include proformas. Default false."),
      },
      annotations: { title: "Client ledger", readOnlyHint: true },
    },
    (args) => {
      if (!args.cif && !args.clientName) {
        return Promise.resolve(jsonResult({ error: "Provide cif or clientName." }));
      }
      return run("ledger", {
        cif: args.cif,
        client: args.clientName,
        from: isoToDdmmyyyy(args.from),
        to: isoToDdmmyyyy(args.to),
        includeProforme: args.includeProforme,
      });
    },
  );

  server.registerTool(
    "list_payments",
    {
      title: "List collections received",
      description:
        "The collections report: money received over a period, each payment linked to the invoice(s) it settled, " +
        "with type (e.g. bank transfer), date, value and currency, plus per-currency totals. Read-only.\n\n" +
        "Use it for 'what did we get paid, and for which invoices?' over a window.",
      inputSchema: {
        from: isoDate.optional().describe("Start (YYYY-MM-DD). Defaults to Jan 1 this year."),
        to: isoDate.optional().describe("End (YYYY-MM-DD). Defaults to today."),
      },
      annotations: { title: "List payments", readOnlyHint: true },
    },
    (args) => run("payments", { from: isoToDdmmyyyy(args.from), to: isoToDdmmyyyy(args.to) }),
  );

  server.registerTool(
    "list_product_sales",
    {
      title: "Product sales report",
      description:
        "Sales grouped by product over a period: quantity, average price and value by currency, with the underlying " +
        "invoice lines (client, document, signed quantities so storno shows as negatives). Read-only.\n\n" +
        "Use it for 'what did we sell, and how much of each?' over a window.",
      inputSchema: {
        from: isoDate.optional().describe("Start (YYYY-MM-DD). Defaults to Jan 1 this year."),
        to: isoDate.optional().describe("End (YYYY-MM-DD). Defaults to today."),
        documentType: z.string().optional().describe("Filter by document type."),
      },
      annotations: { title: "Product sales", readOnlyHint: true },
    },
    (args) => run("productSales", { from: isoToDdmmyyyy(args.from), to: isoToDdmmyyyy(args.to), documentType: args.documentType }),
  );
}
