import { describe, expect, it } from "vitest";
import { SmartBillApiError, SmartBillClient } from "../src/client.js";
import { stubFetch, testConfig } from "./helpers.js";

const noSleep = async () => {};

describe("SmartBillClient", () => {
  it("sends basic auth and JSON bodies to the configured base URL", async () => {
    const { impl, calls } = stubFetch([{ json: { errorText: "", number: "120", series: "FF" } }]);
    const client = new SmartBillClient(testConfig(), impl, noSleep);

    const result = await client.requestJson({
      method: "POST",
      path: "/invoice",
      body: { companyVatCode: "RO12345678" },
    });

    expect(result).toEqual({ errorText: "", number: "120", series: "FF" });
    expect(calls[0]!.url).toBe("https://ws.smartbill.ro/SBORO/api/invoice");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.Authorization).toBe(
      `Basic ${Buffer.from("user@example.com:secret-token").toString("base64")}`,
    );
    expect(calls[0]!.body).toEqual({ companyVatCode: "RO12345678" });
  });

  it("builds query strings and drops empty values", async () => {
    const { impl, calls } = stubFetch([{ json: { errorText: "" } }]);
    const client = new SmartBillClient(testConfig(), impl, noSleep);

    await client.requestJson({
      method: "GET",
      path: "/stocks",
      query: { cif: "RO12345678", date: "2026-07-29", warehouseName: "", productCode: undefined },
    });

    expect(calls[0]!.url).toBe("https://ws.smartbill.ro/SBORO/api/stocks?cif=RO12345678&date=2026-07-29");
  });

  it("percent-encodes series names that contain spaces", async () => {
    const { impl, calls } = stubFetch([{ json: { errorText: "" } }]);
    const client = new SmartBillClient(testConfig(), impl, noSleep);

    await client.requestJson({
      method: "DELETE",
      path: "/invoice",
      query: { cif: "RO1", seriesname: "SERIE TEST", number: "1" },
    });

    expect(calls[0]!.url).toContain("seriesname=SERIE+TEST");
  });

  it("turns a non-empty errorText under HTTP 200 into an error", async () => {
    const { impl } = stubFetch([{ json: { errorText: "Seria nu exista", message: "" } }]);
    const client = new SmartBillClient(testConfig(), impl, noSleep);

    await expect(client.requestJson({ method: "POST", path: "/invoice", body: {} })).rejects.toThrow(
      "Seria nu exista",
    );
  });

  it("surfaces the API message on an HTTP error status", async () => {
    const { impl } = stubFetch([{ status: 400, json: { errorText: "Date invalide" } }]);
    const client = new SmartBillClient(testConfig(), impl, noSleep);

    const error = await client
      .requestJson({ method: "POST", path: "/invoice", body: {} })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SmartBillApiError);
    expect((error as SmartBillApiError).status).toBe(400);
    expect((error as SmartBillApiError).message).toBe("Date invalide");
  });

  it("treats a non-zero status.code from /document/send as an error", async () => {
    const { impl } = stubFetch([{ json: { status: { code: 500, message: "Documentul nu exista" } } }]);
    const client = new SmartBillClient(testConfig(), impl, noSleep);

    await expect(
      client.requestJson({ method: "POST", path: "/document/send", body: {} }),
    ).rejects.toThrow("Documentul nu exista");
  });

  it("accepts status.code 0 from /document/send as success", async () => {
    const { impl } = stubFetch([{ json: { status: { code: 0, message: "OK" } } }]);
    const client = new SmartBillClient(testConfig(), impl, noSleep);

    await expect(
      client.requestJson({ method: "POST", path: "/document/send", body: {} }),
    ).resolves.toEqual({ status: { code: 0, message: "OK" } });
  });

  it("returns PDF bytes with the filename from Content-Disposition", async () => {
    const { impl } = stubFetch([
      {
        body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="FF120.pdf"',
        },
      },
    ]);
    const client = new SmartBillClient(testConfig(), impl, noSleep);

    const binary = await client.requestBinary({ method: "GET", path: "/invoice/pdf" });

    expect(Buffer.from(binary.bytes).toString("utf8")).toBe("%PDF");
    expect(binary.filename).toBe("FF120.pdf");
  });

  it("raises an error when a PDF request answers with a JSON error instead", async () => {
    const { impl } = stubFetch([
      { json: { errorText: "Factura nu exista" }, headers: { "content-type": "application/json" } },
    ]);
    const client = new SmartBillClient(testConfig(), impl, noSleep);

    await expect(client.requestBinary({ method: "GET", path: "/invoice/pdf" })).rejects.toThrow(
      "Factura nu exista",
    );
  });

  it("wraps network failures with the target URL", async () => {
    const failing: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const client = new SmartBillClient(testConfig(), failing, noSleep);

    await expect(client.requestJson({ method: "GET", path: "/tax" })).rejects.toThrow(
      /Could not reach the SmartBill API at https:\/\/ws\.smartbill\.ro\/SBORO\/api\/tax/,
    );
  });

  it("keeps calls at or under 3 per second", async () => {
    const { impl } = stubFetch([{ json: {} }, { json: {} }, { json: {} }, { json: {} }]);
    const waits: number[] = [];
    const client = new SmartBillClient(testConfig(), impl, async (ms) => {
      waits.push(ms);
    });

    await Promise.all(
      [1, 2, 3, 4].map(() => client.requestJson({ method: "GET", path: "/tax" })),
    );

    // The first call goes out immediately; the rest are spaced out.
    expect(waits.filter((ms) => ms > 0).length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the queue alive after a failing call", async () => {
    const { impl } = stubFetch([{ status: 500, json: { errorText: "boom" } }, { json: { ok: true } }]);
    const client = new SmartBillClient(testConfig(), impl, noSleep);

    await expect(client.requestJson({ method: "GET", path: "/tax" })).rejects.toThrow("boom");
    await expect(client.requestJson({ method: "GET", path: "/tax" })).resolves.toEqual({ ok: true });
  });
});
