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
    .enum(["file", "base64"])
    .optional()
    .describe(
      "How to return the PDF: 'file' (default) writes it to the download directory and returns the path; 'base64' returns the bytes inline.",
    ),
};

export async function deliverPdf(
  binary: BinaryResponse,
  fallbackName: string,
  config: SmartBillConfig,
  as: "file" | "base64" = "file",
): Promise<ToolResult> {
  const filename = sanitiseFilename(binary.filename ?? fallbackName);

  if (as === "base64") {
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
  delegateName: z.string().optional(),
  delegateIdentityCard: z.string().optional().describe("Only printed when delegateName is also sent."),
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
