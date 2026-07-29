import { z } from "zod";

export const PAYMENT_TYPES = [
  "Chitanta",
  "Bon",
  "Ordin plata",
  "Card",
  "Card online",
  "CEC",
  "Bilet ordin",
  "Mandat postal",
  "Alta incasare",
  "Extras de cont",
  "Ramburs",
] as const;

/** Payment types that can be removed with DELETE /payment (receipts use their own endpoint). */
export const DELETABLE_PAYMENT_TYPES = [
  "Card",
  "CEC",
  "Bilet ordin",
  "Ordin plata",
  "Mandat postal",
  "Alta incasare",
] as const;

export const DOCUMENT_TYPES = ["factura", "proforma"] as const;

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");

export const clientSchema = z.object({
  name: z.string().describe("Client name as it appears on the document."),
  vatCode: z.string().optional().describe("Client fiscal code (CIF/CUI), e.g. RO12345678."),
  code: z.string().optional().describe("Internal client code in SmartBill."),
  isTaxPayer: z.boolean().optional().describe("True when the client is registered for VAT."),
  regCom: z.string().optional().describe("Trade register number (numar registrul comertului), e.g. J12/345/2020."),
  address: z.string().optional().describe("Street address, printed on the document."),
  contact: z.string().optional().describe("Contact person at the client."),
  city: z.string().optional().describe("City (localitate)."),
  county: z.string().optional().describe("County (judet), e.g. Cluj."),
  country: z.string().optional().describe("Country. Defaults to Romania in SmartBill."),
  email: z.string().optional().describe("Used as the recipient when the document is emailed."),
  phone: z.string().optional().describe("Client phone number."),
  iban: z.string().optional().describe("Client bank account."),
  bank: z.string().optional().describe("Client bank name."),
  saveToDb: z
    .boolean()
    .optional()
    .describe("Save or update this client in the SmartBill client database. Default false."),
});

export const productSchema = z.object({
  name: z.string().describe("Product or service name."),
  code: z.string().optional().describe("Product code."),
  productDescription: z.string().optional().describe("Extra description printed under the line item."),
  translatedName: z.string().optional().describe("Product name in the document language, when it is not RO."),
  translatedMeasuringUnit: z
    .string()
    .optional()
    .describe("Unit of measure in the document language, when it is not RO."),
  measuringUnitName: z.string().optional().describe("Unit of measure, e.g. 'buc', 'ora'. Default 'buc'."),
  currency: z.string().optional().describe("Line currency, e.g. RON, EUR. Default RON."),
  exchangeRate: z.number().optional().describe("Exchange rate to RON when currency is not RON."),
  quantity: z.number().optional().describe("Quantity. Default 1."),
  price: z.number().optional().describe("Unit price, with or without VAT depending on isTaxIncluded."),
  isTaxIncluded: z.boolean().optional().describe("True when `price` already includes VAT. Default true."),
  taxName: z.string().optional().describe("VAT rate name, e.g. 'Normala', 'Redusa', 'SDD', 'Taxare inversa'."),
  taxPercentage: z.number().optional().describe("VAT percentage, e.g. 21, 11, 5, 0."),
  isService: z.boolean().optional().describe("True for services, false for goods."),
  saveToDb: z.boolean().optional().describe("Save the product in the SmartBill catalogue. Default false."),
  warehouseName: z.string().optional().describe("Warehouse to take stock from when useStock is true."),
  isDiscount: z.boolean().optional().describe("True when this line is a discount applied to previous lines."),
  numberOfItems: z
    .number()
    .int()
    .optional()
    .describe("For a discount line: how many preceding lines the discount applies to."),
  discountType: z
    .union([z.literal(1), z.literal(2)])
    .optional()
    .describe("Discount type: 1 = fixed value, 2 = percentage."),
  discountValue: z.number().optional().describe("Discount amount for discountType 1 (use a negative value)."),
  discountPercentage: z.number().optional().describe("Discount percentage for discountType 2."),
});

export const invoicePaymentSchema = z.object({
  type: z.enum(PAYMENT_TYPES).describe("Payment method recorded together with the invoice."),
  value: z.number().describe("Amount collected."),
  isCash: z.boolean().optional().describe("True for cash collection. Default false."),
  paymentSeries: z.string().optional().describe("Receipt series, required when type is 'Chitanta'."),
});

export const emailDetailsSchema = z.object({
  to: z.string().optional().describe("Recipient address. Defaults to the client email set in SmartBill."),
  cc: z.string().optional().describe("Carbon copy address."),
  bcc: z.string().optional().describe("Blind carbon copy address."),
  subject: z.string().optional().describe("Plain text; encoded for the API automatically."),
  bodyText: z.string().optional().describe("Plain text; encoded for the API automatically."),
});

export type ClientInput = z.infer<typeof clientSchema>;
export type ProductInput = z.infer<typeof productSchema>;
export type EmailDetailsInput = z.infer<typeof emailDetailsSchema>;

/** SmartBill expects the email subject and body base64-encoded. */
export function encodeEmailDetails(email: EmailDetailsInput | undefined) {
  if (!email) return undefined;
  return omitUndefined({
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    subject: email.subject === undefined ? undefined : Buffer.from(email.subject, "utf8").toString("base64"),
    bodyText: email.bodyText === undefined ? undefined : Buffer.from(email.bodyText, "utf8").toString("base64"),
  });
}

export function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
