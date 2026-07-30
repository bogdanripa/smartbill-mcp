import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { BinaryResponse, SmartBillClient } from "../client.js";
import type { SmartBillConfig } from "../config.js";
import {
  clientSchema,
  emailDetailsSchema,
  encodeEmailDetails,
  isoDate,
  omitUndefined,
  productSchema,
} from "../schemas.js";

export interface ToolContext {
  client: SmartBillClient;
  config: SmartBillConfig;
}

export type ToolResult = CallToolResult;

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * Resolves a series name from the tool argument, falling back to the configured
 * default. Throws a message that names the environment variable to set.
 */
export function resolveSeries(
  explicit: string | undefined,
  fallback: string | undefined,
  envVar: string,
): string {
  const series = explicit?.trim() || fallback?.trim();
  if (!series) {
    throw new Error(
      `No series name given and no default configured. Pass \`seriesName\`, or set ${envVar} in the environment.`,
    );
  }
  return series;
}

export const documentDeliverySchema = {
  as: z
    .enum(["text", "file", "base64", "document"])
    .optional()
    .describe(
      "What to do with the PDF.\n" +
        "'text' extracts the document's text and returns it — use this to READ the document (issue date, client, " +
        "line items, currency). This is the only mode whose result you can inspect as plain text.\n" +
        "'document' returns the actual PDF as an MCP embedded resource (a binary attachment the client receives " +
        "and can display, save or read). This is the way to hand the real file to the user over HTTP.\n" +
        "'file' writes the PDF to a directory on the SERVER running this tool and returns that path. Over HTTP " +
        "the server is a different machine, so the path is unreachable for you and for the user — it is only " +
        "useful when the client shares a filesystem with the server.\n" +
        "'base64' returns the raw bytes as a JSON string. It exists for a programmatic caller; prefer 'document' " +
        "for delivering a file to the user.\n" +
        "Defaults to 'text' over HTTP.",
    ),
};

/**
 * Pulls the text layer out of a PDF.
 *
 * Every field on an invoice except its amounts — issue date, client, line items,
 * the currency — exists only inside the PDF; no SmartBill endpoint returns them.
 * Without this, that information is unreachable: a path points into the server's
 * own container and base64 cannot be read back by a language model.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  return { text: Array.isArray(text) ? text.join("\n") : text, pages: totalPages };
}

export async function deliverPdf(
  binary: BinaryResponse,
  fallbackName: string,
  config: SmartBillConfig,
  as?: "text" | "file" | "base64" | "document",
): Promise<ToolResult> {
  const filename = sanitiseFilename(binary.filename ?? fallbackName);
  const mode = as ?? config.defaultPdfDelivery;

  if (mode === "text") {
    const { text, pages } = await extractPdfText(binary.bytes);
    return jsonResult({
      filename,
      mimeType: binary.contentType,
      byteLength: binary.bytes.byteLength,
      pages,
      text,
    });
  }

  // The MCP-native way to hand over a binary: an embedded resource whose blob
  // the client receives and can display, save or read. A short text part rides
  // alongside so a client that only shows text still says what was returned.
  if (mode === "document") {
    const mimeType = binary.contentType.includes("pdf") ? binary.contentType : "application/pdf";
    return {
      content: [
        { type: "text", text: `Attached the document as ${filename} (${binary.bytes.byteLength} bytes).` },
        {
          type: "resource",
          resource: {
            uri: `smartbill://pdf/${filename}`,
            mimeType,
            blob: Buffer.from(binary.bytes).toString("base64"),
          },
        },
      ],
    };
  }

  if (mode === "base64") {
    return jsonResult({
      filename,
      mimeType: binary.contentType,
      byteLength: binary.bytes.byteLength,
      base64: Buffer.from(binary.bytes).toString("base64"),
    });
  }

  await mkdir(config.downloadDir, { recursive: true });
  const target = path.resolve(config.downloadDir, filename);
  await writeFile(target, binary.bytes);

  return jsonResult({
    filename,
    path: target,
    mimeType: binary.contentType,
    byteLength: binary.bytes.byteLength,
  });
}

function sanitiseFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "");
  const safe = base || "document.pdf";
  return safe.toLowerCase().endsWith(".pdf") ? safe : `${safe}.pdf`;
}

/** Fields shared by POST /invoice and POST /estimate. */
export const documentBodySchema = {
  client: clientSchema.describe("The client the document is issued to."),
  products: z.array(productSchema).min(1).describe("Line items on the document."),
  seriesName: z.string().optional().describe("Document series. Falls back to the configured default."),
  companyVatCode: z
    .string()
    .optional()
    .describe("Issuing company CIF. Falls back to SMARTBILL_VAT_CODE."),
  issueDate: isoDate.optional().describe("Issue date (YYYY-MM-DD). Defaults to today at SmartBill."),
  dueDate: isoDate.optional().describe("Due date (YYYY-MM-DD)."),
  deliveryDate: isoDate.optional().describe("Delivery date (YYYY-MM-DD)."),
  isDraft: z.boolean().optional().describe("Issue as a draft instead of a final document."),
  currency: z.string().optional().describe("Document currency. Default RON."),
  exchangeRate: z.number().optional().describe("Exchange rate to RON when currency is not RON."),
  language: z.string().optional().describe("Document language: RO, EN, DE, IT, ES, FR, HU. Default RO."),
  precision: z
    .union([z.literal(2), z.literal(3), z.literal(4)])
    .optional()
    .describe("Number of decimals used for amounts. Default 2."),
  issuerCnp: z.string().optional().describe("Personal numeric code of the issuing person."),
  issuerName: z.string().optional().describe("Name of the issuing person."),
  mentions: z.string().optional().describe("Free text printed on the document."),
  observations: z.string().optional().describe("Internal note; not printed on the document."),
  delegateName: z.string().optional().describe("Person collecting the goods (delegat), printed on the document."),
  delegateIdentityCard: z
    .string()
    .optional()
    .describe("Delegate ID card series and number; only printed when delegateName is also sent."),
  delegateAuto: z
    .string()
    .optional()
    .describe("Delegate vehicle; only printed when delegateName and delegateIdentityCard are also sent."),
  sendEmail: z.boolean().optional().describe("Email the document to the client on issue."),
  email: emailDetailsSchema.optional().describe("Email overrides used when sendEmail is true."),
};

type DocumentBodyArgs = {
  [K in keyof typeof documentBodySchema]: z.infer<(typeof documentBodySchema)[K]>;
};

export function buildDocumentBody(
  args: DocumentBodyArgs,
  seriesName: string,
  companyVatCode: string,
): Record<string, unknown> {
  const { client, products, email, ...rest } = args;
  return omitUndefined({
    ...rest,
    companyVatCode,
    seriesName,
    client: omitUndefined(client),
    products: products.map((product) => omitUndefined(product)),
    email: encodeEmailDetails(email),
  });
}
