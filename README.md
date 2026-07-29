# smartbill-mcp

An MCP server for the [SmartBill Cloud](https://www.smartbill.ro/) API. It lets an
MCP client issue and manage Romanian invoices, proformas and payments, download
document PDFs, and read VAT rates, series and stock levels.

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
| `HOST` | `0.0.0.0` | Interface to bind. |
| `MCP_PATH` | `/mcp` | Base path the endpoint is mounted at. |
| `MCP_ALLOWED_HOSTS` | — | Comma-separated `Host` values to accept (DNS rebinding protection). Unset accepts any. |

No `SMARTBILL_*` secrets are read in this mode — the server holds none.
`GET /health` answers `{"status":"ok"}` without credentials, for platform health
checks.

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
| `cancel_payment` | Cancel a receipt without deleting it. |
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

**PDFs.** Over stdio, `get_invoice_pdf` and `get_estimate_pdf` write the file to
`SMARTBILL_DOWNLOAD_DIR` and return the path. Over HTTP the server has no
filesystem the client can read, so they return base64 bytes instead. Either
default can be overridden per call with `as: "file" | "base64"`.

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

SmartBill's reference lives at <https://api.smartbill.ro/>. The endpoints, field
names and query parameters used here match the published SmartBill SDKs. Two
details are worth flagging:

- `delete_payment` calls `DELETE /payment` with query parameters. SmartBill also
  documents a `/payment/v2` variant; if your account rejects the call, set
  `SMARTBILL_BASE_URL` or open an issue.
- `create_invoice_from_estimate` sends `useEstimateDetails: true` with an
  `estimate` reference and no client block, letting SmartBill copy the client and
  line items from the proforma.

## License

MIT
