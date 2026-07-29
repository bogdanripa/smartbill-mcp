import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const minimal = {
  SMARTBILL_USERNAME: "user@example.com",
  SMARTBILL_TOKEN: "token",
  SMARTBILL_VAT_CODE: "RO1",
} as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("applies defaults for the optional settings", () => {
    const config = loadConfig(minimal);

    expect(config.baseUrl).toBe("https://ws.smartbill.ro/SBORO/api");
    expect(config.downloadDir).toBe("./smartbill-downloads");
    expect(config.defaultInvoiceSeries).toBeUndefined();
  });

  it("names the variable that is missing", () => {
    expect(() => loadConfig({ ...minimal, SMARTBILL_TOKEN: undefined })).toThrow(/SMARTBILL_TOKEN/);
    expect(() => loadConfig({ ...minimal, SMARTBILL_VAT_CODE: "   " })).toThrow(/SMARTBILL_VAT_CODE/);
  });

  it("trims values and ignores blank optional ones", () => {
    const config = loadConfig({ ...minimal, SMARTBILL_VAT_CODE: " RO1 ", SMARTBILL_INVOICE_SERIES: "  " });

    expect(config.companyVatCode).toBe("RO1");
    expect(config.defaultInvoiceSeries).toBeUndefined();
  });
});
