#!/usr/bin/env node
/**
 * Prints the MCP URL for a set of SmartBill credentials, so nobody has to
 * hand-assemble the base64url segment.
 *
 *   npx smartbill-mcp-url https://smartbill.example.com you@example.com TOKEN RO12345678 [FF] [PF] [CH]
 */
import { encodeCredentials } from "./credentials.js";

const [baseUrl, username, token, cif, invoiceSeries, estimateSeries, receiptSeries] = process.argv.slice(2);

if (!baseUrl || !username || !token || !cif) {
  console.error(
    "Usage: smartbill-mcp-url <server-url> <username> <token> <cif> [invoiceSeries] [estimateSeries] [receiptSeries]",
  );
  process.exit(1);
}

const url = new URL(baseUrl);
const base = url.pathname.replace(/\/+$/, "") || "/mcp";
url.pathname = `${base}/${encodeCredentials({ username, token, companyVatCode: cif })}`;

if (invoiceSeries) url.searchParams.set("invoiceSeries", invoiceSeries);
if (estimateSeries) url.searchParams.set("estimateSeries", estimateSeries);
if (receiptSeries) url.searchParams.set("receiptSeries", receiptSeries);

console.log(url.toString());
