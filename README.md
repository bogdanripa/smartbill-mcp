# smartbill-mcp

An MCP server for the [SmartBill Cloud](https://www.smartbill.ro/) API. It lets an
MCP client issue and manage Romanian invoices, proformas and payments, download
document PDFs, and read VAT rates, series and stock levels.

## Setup

```bash
npm install
npm run build
```

You need a SmartBill Cloud account with API access enabled. The token is
generated in **Contul meu → Integrari → API**; the username is the email you log
in with.

```bash
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

## Connecting a client

The server speaks MCP over stdio. For Claude Code:

```bash
claude mcp add smartbill \
  --env SMARTBILL_USERNAME=you@example.com \
  --env SMARTBILL_TOKEN=your-api-token \
  --env SMARTBILL_VAT_CODE=RO12345678 \
  --env SMARTBILL_INVOICE_SERIES=FF \
  -- node /absolute/path/to/smartbill-mcp/dist/index.js
```

Or, for any client that reads a JSON config:

```json
{
  "mcpServers": {
    "smartbill": {
      "command": "node",
      "args": ["/absolute/path/to/smartbill-mcp/dist/index.js"],
      "env": {
        "SMARTBILL_USERNAME": "you@example.com",
        "SMARTBILL_TOKEN": "your-api-token",
        "SMARTBILL_VAT_CODE": "RO12345678",
        "SMARTBILL_INVOICE_SERIES": "FF"
      }
    }
  }
}
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

## Behaviour worth knowing

**Errors.** SmartBill reports business failures with HTTP 200 and a non-empty
`errorText` (and the email endpoint uses a `status.code` instead). Both are
turned into tool errors, so a failed call never looks like a success.

**Rate limiting.** SmartBill allows 3 calls per second. The client serialises
requests and spaces them out, so a burst of tool calls queues instead of failing.

**PDFs.** `get_invoice_pdf` and `get_estimate_pdf` write the file to
`SMARTBILL_DOWNLOAD_DIR` and return the path. Pass `as: "base64"` to get the
bytes inline instead — useful when the client has no access to the filesystem.

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
npm run dev       # run from source with tsx
```

Tests drive the real MCP server over an in-memory transport with a stubbed
`fetch`, so they cover the tool schemas, the request bodies sent to SmartBill and
the error mapping.

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
