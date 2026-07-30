# smartbill-mcp

An MCP server for the [SmartBill Cloud](https://www.smartbill.ro/) API. It lets an
MCP client issue and manage Romanian invoices, proformas and payments, download
document PDFs, and read VAT rates, series and stock levels.

Run in hosted mode with a database, it also adds session-backed **reporting
tools** the public API cannot provide — customer roster, receivables/aging,
client statements and ledgers, collections and product sales (see
[Portal report tools](#portal-report-tools)).

> **Hosted instance:** a public deployment runs at
> <https://smartbill-mcp-coolify.bogdanripa.com/>. Open it in a browser to
> connect your own SmartBill account and generate a connector URL.

It runs two ways:

- **stdio**, single account, on your machine — credentials come from the environment.
- **HTTP**, multi-tenant, hosted — credentials arrive with each request, so one
  deployment serves any number of SmartBill accounts.

## Credentials

You need a SmartBill Cloud account with API access. The token is generated in
**Contul meu → Integrari → API**; the username is the email you log in with. A
SmartBill token is a bearer credential with **full account access and no
scoping** — anything holding it can issue and delete real fiscal documents.

## Running over stdio

```bash
npm install
npm run build
cp .env.example .env   # then fill it in
```

| Variable | Required | Description |
| --- | --- | --- |
| `SMARTBILL_USERNAME` | yes | Account email. |
| `SMARTBILL_TOKEN` | yes | API token from SmartBill Cloud. |
| `SMARTBILL_VAT_CODE` | yes | Your company CIF, used as the default `cif` on every call. |
| `SMARTBILL_INVOICE_SERIES` | no | Default invoice series, e.g. `FF`. |
| `SMARTBILL_ESTIMATE_SERIES` | no | Default proforma series. |
| `SMARTBILL_RECEIPT_SERIES` | no | Default receipt (chitanta) series. |
| `SMARTBILL_DOWNLOAD_DIR` | no | Where PDFs are written. Default `./smartbill-downloads`. |
| `SMARTBILL_BASE_URL` | no | Override the API base URL. |

The series defaults are optional but convenient: with them set, tools can be
called with just a document number. Without them, pass `seriesName` explicitly.

```bash
claude mcp add smartbill \
  --env SMARTBILL_USERNAME=you@example.com \
  --env SMARTBILL_TOKEN=your-api-token \
  --env SMARTBILL_VAT_CODE=RO12345678 \
  --env SMARTBILL_INVOICE_SERIES=FF \
  -- node /absolute/path/to/smartbill-mcp/dist/index.js
```

The token is read once at startup, turned into an `Authorization: Basic` header
inside the HTTP client, and never enters the model's context — no tool takes a
credential argument, so it cannot surface in a tool result.

## Running over HTTP (multi-tenant)

```bash
npm run build
npm run start:http     # or: node dist/index.js --http
```

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_TRANSPORT` | — | Set to `http` instead of passing `--http`. |
| `PORT` | `80` | Port to listen on. |
| `HOST` | `::` | Interface to bind (dual-stack; falls back to IPv4 if IPv6 is unavailable). |
| `MCP_PATH` | `/mcp` | Base path the endpoint is mounted at. |
| `MCP_ALLOWED_HOSTS` | — | Comma-separated `Host` values to accept (DNS rebinding protection). Unset accepts any. |
| `DATABASE_URL` | — | Postgres connection string. Set with `SMARTBILL_SESSION_KEY` to enable the [portal report tools](#portal-report-tools) and the sign-in setup page. |
| `SMARTBILL_SESSION_KEY` | — | 32-byte key as 64 hex chars, encrypts stored credentials at rest. Required alongside `DATABASE_URL`. |

No per-account `SMARTBILL_*` secrets are read in this mode — each caller's
credentials arrive with the request, and the server holds none.
`GET /health` answers without credentials, for platform health checks:

```json
{ "status": "ok", "version": "0.1.0", "commit": "9f2c1ab..." }
```

`commit` is the git SHA the image was built from, baked in via the `BUILD_SHA`
build argument (`"dev"` outside a built image). It exists because a redeploy
leaves the outgoing container serving: a check that only asks for a 200 is
answered by the container being replaced. The deploy workflow waits for
`commit` to equal the SHA it just built, so it tests the new container rather
than racing it.

### The setup page

Opening the deployment's root in a browser serves a self-service page that
explains what the server does, asks for the SmartBill **email and password**, and
returns a ready-to-paste connector URL.

Submitting the form POSTs the credentials to `/setup`. The server signs in to
SmartBill, reads the account's scoped API token and CIF, stores the tenant — the
password and session cookies encrypted at rest with `SMARTBILL_SESSION_KEY` (see
[Portal report tools](#portal-report-tools)) — and responds with the connector
URL. The password is only ever used to talk to SmartBill; it is never logged or
sent back.

The page loads no third-party scripts, styles or fonts and talks to nothing but
this server's own `/setup`. `test/http.test.ts` asserts that, so a future edit
can't quietly add an external subresource that could observe what the user types.

The setup page and the portal flow require `DATABASE_URL` + `SMARTBILL_SESSION_KEY`.
Without them the server runs public-API only: `/setup` answers `503` and callers
supply their own token via the URL or a header (below).

Non-browser callers (`Accept` without `text/html`) still get JSON at the root,
so health checks and monitoring are unaffected.

### Credentials in the URL

Each caller's credentials travel as one base64url segment of
`username:token:cif`:

```
https://smartbill.example.com/mcp/<credentials>?invoiceSeries=FF
```

Generate the URL rather than assembling it by hand:

```bash
npm run make-url -- https://smartbill.example.com/mcp you@example.com TOKEN RO12345678 FF PF CH
```

The optional `invoiceSeries`, `estimateSeries` and `receiptSeries` query
parameters set that tenant's series defaults, matching the stdio env vars.

This is the form to use with clients that only accept a URL — including
claude.ai's **Add custom connector** dialog, which has fields for a URL and
OAuth credentials but none for custom headers.

**The URL is the secret.** Anyone holding it can issue and delete fiscal
documents on that account, and URLs leak more readily than headers do: they land
in reverse-proxy access logs, error pages and crash traces. Mitigate it:

- Turn off request-path logging on whatever proxy sits in front (Traefik/Coolify).
  This server never logs the URL itself.
- Treat the URL like a password: don't paste it into shared docs or tickets.
- To revoke, regenerate the SmartBill token — that invalidates every URL built
  from it.

### Credentials in a header

Clients that can send headers should, since the token then stays out of access
logs. Send both:

```
Authorization: Basic base64(username:token)
X-SmartBill-Cif: RO12345678
```

against the bare `/mcp` path. Query parameters for series defaults still apply.
When both a header and a URL segment are present, the header wins.

### Deploying

The `Dockerfile` builds for the runtime Prionman expects — `linux/arm64`,
listening on port 80, no secrets baked into the image:

```bash
docker build --platform linux/arm64 -t smartbill-mcp .
docker run -p 8080:80 smartbill-mcp
```

## Tools

### Invoices

| Tool | What it does |
| --- | --- |
| `create_invoice` | Issue an invoice, optionally recording a payment and emailing it. |
| `create_invoice_from_estimate` | Issue an invoice that copies its details from a proforma. |
| `create_reverse_invoice` | Issue a storno invoice reversing an existing one. |
| `get_invoice_pdf` | Download the invoice PDF. |
| `get_invoice_payment_status` | Total, paid and unpaid amounts for an invoice. |
| `cancel_invoice` / `restore_invoice` | Cancel an invoice, or undo the cancellation. |
| `delete_invoice` | Permanently delete an invoice. |

### Estimates (proforme)

| Tool | What it does |
| --- | --- |
| `create_estimate` | Issue a proforma. |
| `get_estimate_pdf` | Download the proforma PDF. |
| `get_estimate_invoices` | List invoices already issued from a proforma. |
| `cancel_estimate` / `restore_estimate` | Cancel a proforma, or undo the cancellation. |
| `delete_estimate` | Permanently delete a proforma. |

### Payments

| Tool | What it does |
| --- | --- |
| `create_payment` | Record a collection, optionally settling specific invoices. |
| `delete_receipt` | Delete a receipt (chitanta) by series and number. |
| `delete_payment` | Delete a non-receipt payment (card, transfer, ...). |
| `get_fiscal_receipt_text` | Printable text of a fiscal receipt, base64-decoded for you. |

### Account and catalogue

| Tool | What it does |
| --- | --- |
| `list_series` | Document series configured on the account, with their next number. |
| `list_taxes` | VAT rates, for the `taxName` / `taxPercentage` fields on invoice lines. |
| `list_stocks` | Stock levels on a date, optionally per warehouse or product. |
| `send_document_email` | Email an already-issued invoice or proforma. |

### Portal report tools

Registered only in hosted mode with `DATABASE_URL` + `SMARTBILL_SESSION_KEY` set.
They read the SmartBill web account through an authenticated session to answer the
questions the public API cannot — the customer roster and the reports behind
SmartBill Cloud's dashboards. All read-only.

| Tool | What it does |
| --- | --- |
| `list_clients` | Search / list customers (the nomenclator), by name substring. |
| `get_client_details` | A customer's full record — address, CIF, IBAN, VAT-payer status. |
| `list_receivables` | Unpaid invoices with status and days overdue, grouped by client. |
| `list_client_balances` | Outstanding balance per client as of a date. |
| `get_client_statement` | Every document issued to one client over a period. |
| `get_client_ledger` | A client's ledger with a running balance. |
| `list_payments` | Collections received over a period, linked to the invoices they settled. |
| `list_product_sales` | Sales grouped by product over a period. |

Onboarding (via the [setup page](#the-setup-page)) stores the account login
encrypted with `SMARTBILL_SESSION_KEY`, so an expired session is renewed
automatically. After three consecutive sign-in failures the account is frozen and
the tools ask the user to re-enter their credentials on the setup page, which
clears the block.

### How the tools are documented

The descriptions are written for a model choosing between them, not just for a
human reading the list. Every tool states what it does, **when to reach for it**,
what it returns, and which sibling tool to use instead when it is the wrong
choice — `delete_invoice` points at `cancel_invoice`, `create_invoice` points at
`create_invoice_from_estimate`, and so on. Irreversible tools say so and ask for
confirmation; read-only ones are marked `readOnlyHint` and destructive ones
`destructiveHint`, so clients can gate them.

The server also ships `instructions`, which explain the domain a model has to get
right up front: how series and numbers work, the difference between an invoice, a
proforma and a payment, and the asymmetry between deleting, cancelling and
reversing.

`test/documentation.test.ts` enforces this — it fails the build if a tool loses
its title, gets a thin description, stops saying when to use it, drops one of the
cross-references, or grows an undocumented parameter.

## Behaviour worth knowing

**Errors.** SmartBill reports business failures with HTTP 200 and a non-empty
`errorText` (and the email endpoint uses a `status.code` instead). Both are
turned into tool errors, so a failed call never looks like a success.

**Rate limiting.** SmartBill allows 3 calls per second. The client serialises
requests and spaces them out, so a burst of tool calls queues instead of failing.

**PDFs.** Delivery is chosen with `as`. The default is `text` over HTTP (the
extracted text layer — the only readable form of a document's fields) and `file`
over stdio (writes to `SMARTBILL_DOWNLOAD_DIR`). To hand the actual file to the
user, pass `as: "document"`: the PDF comes back as an MCP embedded resource the
client can display or save. `as: "base64"` returns the raw bytes for a
programmatic caller.

**Email fields.** SmartBill expects the email subject and body base64-encoded.
Pass plain text; the encoding is handled for you.

**Irreversibility.** Only the last document in a series can be deleted. Older
documents can be cancelled (`cancel_invoice`) or reversed with a storno invoice
(`create_reverse_invoice`). The server tells the model this in its instructions
and marks the destructive tools accordingly, but the client still decides whether
to prompt — treat write tools as needing confirmation.

## Development

```bash
npm test          # vitest, no network access needed
npm run typecheck
npm run dev       # stdio, from source
```

Tests drive the real MCP server — over an in-memory transport for the tool layer
and over a real socket for the HTTP layer — with a stubbed `fetch`, so they cover
the tool schemas, the request bodies sent to SmartBill, the error mapping and
per-tenant credential isolation.

## Notes on the API surface

SmartBill's reference lives at <https://api.smartbill.ro/>, which serves a
Swagger spec at <https://api.smartbill.ro/data/swagger.json>. Every endpoint,
field name and query parameter used here has been checked against it. Three
details are worth flagging:

- `delete_payment` calls `DELETE /payment/v2`. The plain `/payment` path accepts
  only `POST`; the delete operation for non-receipt collections lives on `/v2`,
  and takes the same query parameters this tool already sent.
- Receipts have no cancel operation. Invoices and proformas can be voided while
  keeping their number (`/invoice/cancel`, `/estimate/cancel`), but there is no
  `/payment/cancel` — a receipt can only be deleted, and only if it is the last
  one in its series.
- `create_payment` sends the internal note as `observation`, singular. Invoices
  and proformas spell the same field `observations`.

### Document details live only in the PDF

No endpoint returns an invoice's issue date, client or line items.
`/invoice/paymentstatus` gives three amounts and a `paid` flag; that is the whole
of the structured data available about an issued document. Everything else exists
only as rendered text inside the PDF.

`get_invoice_pdf` and `get_estimate_pdf` therefore default to `as: "text"` over
HTTP, which extracts the text layer (via `unpdf`, no system dependency) and
returns it — the only mode whose output a language model can inspect. The other
modes:

- `document` returns the PDF as an MCP embedded resource (a binary blob the
  client receives, with `mimeType: application/pdf`). This is the way to deliver
  the actual file to a user over HTTP.
- `file` writes the PDF to `SMARTBILL_DOWNLOAD_DIR` on the machine running the
  server. Over HTTP that is a different machine, and nothing is served from that
  directory, so it is useful only for stdio, where client and server share a
  filesystem.
- `base64` returns the raw bytes as a JSON string, for a programmatic caller.

`send_document_email` is an alternative for delivery: it has SmartBill mail the
document to the client.

### Amounts carry no currency

`GET /invoice/paymentstatus` returns `invoiceTotalAmount`, `paidAmount` and
`unpaidAmount` as bare doubles. The documented response schema has no currency
field, and the figures are in whatever currency the invoice was issued in — an
EUR invoice returns the EUR amount, indistinguishable from a RON one.

Read unqualified next to a Romanian invoicing service, that reads as RON. It
happened: a 1250 EUR invoice was reported as "1250 RON", understating it more
than fivefold. `get_invoice_payment_status` therefore annotates its result with
`currency: "unknown"` and a note, so the caveat sits beside the number rather
than only in the tool description. `get_invoice_pdf` is the way to establish the
actual currency.

### What the API cannot do

There is no way to enumerate anything. The published API is 20 paths, and every
document read — `/invoice/paymentstatus`, `/invoice/pdf`, `/estimate/pdf`,
`/estimate/invoices` — is keyed by `cif` + `seriesName` + `number`. There is no
search, no date range, no pagination, and no customer resource of any kind:
clients are only ever written, as a nested block on a document, with `saveToDb`
persisting them into the nomenclator with no read path back out.

So "all invoices for client ABC", "everything issued last month" and "list my
customers" are not answerable through this API. `/tax`, `/series` and `/stocks`
are the only endpoints that return a list. The server instructions tell the model
this, so it reports the limitation instead of probing series numbers one at a
time — which would also hit SmartBill's request rate limit.

In hosted mode with a database, the [portal report tools](#portal-report-tools)
answer exactly these questions by reading the web account through an
authenticated session; without that configuration the limitation stands, and the
instructions adapt to whichever set of tools is registered.

`create_invoice_from_estimate` sends `useEstimateDetails: true` with an
`estimate` reference and no client block, letting SmartBill copy the client and
line items from the proforma — this matches the documented
`exempluFacturaDinProforma` shape.

## License

MIT
