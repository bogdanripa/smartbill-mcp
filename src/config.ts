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
  /** Directory PDFs are written to when they are delivered as files. */
  downloadDir: string;
  /**
   * How PDFs are returned when the caller does not say. Writing a file only helps
   * a client that shares a filesystem with the server, so hosted deployments
   * default to base64.
   */
  defaultPdfDelivery: "file" | "base64";
  baseUrl: string;
}

export interface Credentials {
  username: string;
  token: string;
  companyVatCode: string;
  defaultInvoiceSeries?: string;
  defaultEstimateSeries?: string;
  defaultReceiptSeries?: string;
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

/** Settings that are the same for every tenant of a given deployment. */
export function loadServerSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    downloadDir: optional(env.SMARTBILL_DOWNLOAD_DIR) ?? "./smartbill-downloads",
    baseUrl: optional(env.SMARTBILL_BASE_URL) ?? "https://ws.smartbill.ro/SBORO/api",
  };
}

/** Builds a config from per-request credentials, for the multi-tenant HTTP transport. */
export function buildConfig(
  credentials: Credentials,
  overrides: Partial<SmartBillConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): SmartBillConfig {
  return {
    ...credentials,
    ...loadServerSettings(env),
    defaultPdfDelivery: "file",
    ...overrides,
  };
}

/** Builds a config from the environment, for the single-account stdio transport. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SmartBillConfig {
  return buildConfig(
    {
      username: required("SMARTBILL_USERNAME", env.SMARTBILL_USERNAME),
      token: required("SMARTBILL_TOKEN", env.SMARTBILL_TOKEN),
      companyVatCode: required("SMARTBILL_VAT_CODE", env.SMARTBILL_VAT_CODE),
      defaultInvoiceSeries: optional(env.SMARTBILL_INVOICE_SERIES),
      defaultEstimateSeries: optional(env.SMARTBILL_ESTIMATE_SERIES),
      defaultReceiptSeries: optional(env.SMARTBILL_RECEIPT_SERIES),
    },
    {},
    env,
  );
}

export { ConfigError };
