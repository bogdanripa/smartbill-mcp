// The internal SmartBill Cloud endpoints, ported verbatim from the proven probe
// (scripts/portal-probe.mjs on the claude/smartbill-mcp-tests branch). Each
// build() returns the POST body as a flat string map; the odd bits (DataTables
// scaffolding, the trailing-space "daysOutOfDate " key, plain-form vs sSearch
// JSON) mirror real captures and must not be "tidied" without re-testing.

export type PortalParams = Record<string, string | number | boolean | undefined>;

export interface PortalEndpoint {
  path: string;
  method: "GET" | "POST";
  /** Builds the form body for a POST endpoint. Omitted for GET. */
  build?: (p: PortalParams) => Record<string, string>;
}

// ---- date helpers ---------------------------------------------------------
function pad(n: number): string {
  return String(n).padStart(2, "0");
}
/** SmartBill wants dd/mm/yyyy throughout. */
export function ddmmyyyy(d: Date): string {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
function today(): string {
  return ddmmyyyy(new Date());
}
function yearStart(): string {
  return `01/01/${new Date().getFullYear()}`;
}

function str(v: PortalParams[string]): string | undefined {
  if (v === undefined) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

// ---- DataTables scaffolding (clienti, incasari) ---------------------------
function dataTablesBase(columns: number, notSortable: number[]): Record<string, string> {
  const body: Record<string, string> = {
    sEcho: "1",
    iColumns: String(columns),
    sColumns: "",
    iSortingCols: "0",
  };
  const noSort = new Set(notSortable);
  for (let i = 0; i < columns; i++) {
    body[`mDataProp_${i}`] = String(i);
    body[`sSearch_${i}`] = "";
    body[`bRegex_${i}`] = "false";
    body[`bSearchable_${i}`] = "true";
    body[`bSortable_${i}`] = noSort.has(i) ? "false" : "true";
  }
  return body;
}

// ---------------------------------------------------------------------------
// The catalogue. Keys that back an MCP tool are marked; `integrations` and
// `login` are internal (integrations is scraped during onboarding; login lives
// in session.ts).
// ---------------------------------------------------------------------------
export const ENDPOINTS = {
  // Customer roster + name substring search (DataTables, 8 columns).
  clients: {
    path: "/nomenclator/clienti/ajax/",
    method: "POST",
    build: (p) => ({
      ...dataTablesBase(8, [0, 7]),
      iDisplayStart: str(p.start) ?? "0",
      iDisplayLength: str(p.length) ?? "50",
      sSearch: JSON.stringify({ client_name: str(p.search) ?? "" }),
      bRegex: "false",
      displayCodes: "true",
    }),
  },

  // Aging / receivables: status + days overdue per invoice, grouped by client.
  //
  // Paged by `results_per_page` + 1-based `page`, both INSIDE the sSearch JSON.
  // Probed against the live portal: the DataTables keys (iDisplayStart /
  // iDisplayLength, with or without column scaffolding) and top-level
  // results_per_page / start / length are all ignored here, and page 1 + page 2
  // reconstruct the full ordered set with no overlap. Send no page size at all
  // and SmartBill quietly serves 10 clients while clientsCount still reports the
  // true total — a short list that looks complete.
  receivables: {
    path: "/raport/facturi-neincasate/ajax/",
    method: "POST",
    build: (p) => {
      const from = str(p.from) ?? yearStart();
      const to = str(p.to) ?? today();
      return {
        sSearch: JSON.stringify({
          reportType: 1,
          results_per_page: p.length !== undefined ? Number(p.length) : 200,
          page: p.page !== undefined ? Number(p.page) : 1,
          displayPayments: true,
          periodFilter: 0,
          periodStartDate: from,
          periodEndDate: to,
          clientName: str(p.client) ?? "",
          paymentStatus: p.paymentStatus !== undefined ? Number(p.paymentStatus) : 1,
          daysUpToDate: ["0-0", "1-7", "8-14", "15-30", "31-*"],
          "daysOutOfDate ": "1-7;8-30;31-60;61-90;91-*", // trailing space verbatim
          currencyId: "-1",
          doCurrencyConvertion: false,
          displayBalance: false,
          selectUpToDate: { first: true, second: true, third: true, fourth: true, fifth: true },
          selectOutOfDate: {},
          from,
          to,
        }),
      };
    },
  },

  // Outstanding balance per client, point-in-time (sold vs soldAzi).
  balances: {
    path: "/raport/sume_de_incasat/ajax/",
    method: "POST",
    build: (p) => ({
      sSearch: JSON.stringify({
        client: str(p.client) ?? "",
        date: str(p.date) ?? today(),
        fisa_client_cif: str(p.cif) ?? "",
        results_per_page: p.length !== undefined ? Number(p.length) : 200,
        show_sold_curent: true,
        include_zero_sold_clients: p.includeZero === true || p.includeZero === "true",
        include_chitante_fara_factura: true,
        currency: "0",
      }),
    }),
  },

  // Client statement: every document for one client over a date range (by CIF).
  statement: {
    path: "/raport/lista_tranzactii/ajax/",
    method: "POST",
    build: (p) => ({
      sSearch: JSON.stringify({
        client: str(p.client) ?? "",
        from: str(p.from) ?? yearStart(),
        to: str(p.to) ?? today(),
        results_per_page: p.length !== undefined ? Number(p.length) : 200,
        currency: "0",
        document_type: str(p.documentType) ?? "",
        document_number: str(p.documentNumber) ?? "",
        client_id: str(p.clientId) ?? "", // CIF alone is sufficient
        fisa_client_cif: str(p.cif) ?? "",
        fisa_client: true,
      }),
    }),
  },

  // Client ledger with a running balance (balanceEntries[] + opening row).
  ledger: {
    path: "/raport/evolutia_soldului/ajax/",
    method: "POST",
    build: (p) => ({
      sSearch: JSON.stringify({
        client: str(p.client) ?? "",
        from: str(p.from) ?? yearStart(),
        to: str(p.to) ?? today(),
        results_per_page: p.length !== undefined ? Number(p.length) : 200,
        include_proforme: p.includeProforme === true || p.includeProforme === "true",
        include_chitante_fara_factura: true,
        include_bonuri_fara_factura: true,
        currency: "0",
        document_type: str(p.documentType) ?? "",
        document_number: str(p.documentNumber) ?? "",
        fisa_client_cif: str(p.cif) ?? "",
        fisa_client: true,
      }),
    }),
  },

  // Collections received (incasari), linked to settled invoices (DataTables, 14 cols).
  payments: {
    path: "/raport/incasari/ajax/",
    method: "POST",
    build: (p) => ({
      ...dataTablesBase(14, [0, 4, 8, 9, 10, 11, 12, 13]),
      iDisplayStart: str(p.start) ?? "0",
      iDisplayLength: str(p.length) ?? "50",
      sSearch: JSON.stringify({ from: str(p.from) ?? yearStart(), to: str(p.to) ?? today(), currency: "0" }),
      bRegex: "",
      last_documents_ids: "[]",
    }),
  },

  // Product-sales report: per-product totals + nested per-document lines.
  productSales: {
    path: "/raport/vanzari-produse/ajax/",
    method: "POST",
    build: (p) => ({
      sSearch: JSON.stringify({
        reportType: 1,
        from: str(p.from) ?? yearStart(),
        to: str(p.to) ?? today(),
        currencyId: "-1",
        doCurrencyConvertion: false,
        documentType: str(p.documentType) ?? "",
        page: p.page !== undefined ? Number(p.page) : 1,
        results_per_page: p.length !== undefined ? Number(p.length) : 50,
        products_type: "0",
        save_filter: true,
      }),
    }),
  },

  // Full client record by name + CIF. NOTE: plain form fields, not sSearch JSON.
  clientDetails: {
    path: "/documente/get_document_client/",
    method: "POST",
    build: (p) => ({ client_name: str(p.client) ?? "", client_cif: str(p.cif) ?? "" }),
  },

  // Internal: the integrations page (HTML, GET) — scraped for the API token/CIF.
  integrations: {
    path: "/core/integrari/",
    method: "GET",
  },
} as const satisfies Record<string, PortalEndpoint>;

export type PortalEndpointName = keyof typeof ENDPOINTS;
