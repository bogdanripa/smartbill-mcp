export interface SmartBillConfig {
  /** Account email used to log into SmartBill Cloud. */
  username: string;
  /** API token generated from the SmartBill Cloud account (Contul meu > Integrari > API). */
  token: string;
  /** Company VAT code (CIF) used as the default `cif` for every call. */
  companyVatCode: string;
  /** Optional default series, so tools can omit `seriesName`. */
  defaultInvoiceSeries?: string;
  defaultEstimateSeries?: string;
  defaultReceiptSeries?: string;
  /** Directory PDFs are written to. */
  downloadDir: string;
  baseUrl: string;
}

class ConfigError extends Error {}

function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new ConfigError(
      `Missing required environment variable ${name}. ` +
        `Set SMARTBILL_USERNAME, SMARTBILL_TOKEN and SMARTBILL_VAT_CODE before starting the server.`,
    );
  }
  return trimmed;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SmartBillConfig {
  return {
    username: required("SMARTBILL_USERNAME", env.SMARTBILL_USERNAME),
    token: required("SMARTBILL_TOKEN", env.SMARTBILL_TOKEN),
    companyVatCode: required("SMARTBILL_VAT_CODE", env.SMARTBILL_VAT_CODE),
    defaultInvoiceSeries: optional(env.SMARTBILL_INVOICE_SERIES),
    defaultEstimateSeries: optional(env.SMARTBILL_ESTIMATE_SERIES),
    defaultReceiptSeries: optional(env.SMARTBILL_RECEIPT_SERIES),
    downloadDir: optional(env.SMARTBILL_DOWNLOAD_DIR) ?? "./smartbill-downloads",
    baseUrl: optional(env.SMARTBILL_BASE_URL) ?? "https://ws.smartbill.ro/SBORO/api",
  };
}

export { ConfigError };
