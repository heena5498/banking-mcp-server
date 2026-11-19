import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { formatMoney, maskAccountNumber } from "../src/format.js";
import { createLogger } from "../src/logger.js";
import { ToolError, errorResult } from "../src/errors.js";

describe("loadConfig", () => {
  it("accepts a token and applies defaults", () => {
    const c = loadConfig({ BANK_API_BASE_URL: "http://localhost:8080/", BANK_API_TOKEN: "t" });
    expect(c).toMatchObject({ baseUrl: "http://localhost:8080", token: "t", timeoutMs: 5000, logLevel: "info" });
  });

  it("accepts email + password instead of a token", () => {
    const c = loadConfig({ BANK_API_BASE_URL: "http://x", BANK_EMAIL: "a@b.c", BANK_PASSWORD: "p" });
    expect(c.credentials).toEqual({ email: "a@b.c", password: "p" });
    expect(c.token).toBeUndefined();
  });

  it("treats empty strings as unset (as in a copied .env.example)", () => {
    expect(() => loadConfig({ BANK_API_BASE_URL: "http://x", BANK_API_TOKEN: "", BANK_EMAIL: "" })).toThrow(/BANK_API_TOKEN/);
  });

  it("fails clearly without a base URL", () => {
    expect(() => loadConfig({ BANK_API_TOKEN: "t" })).toThrow(/BANK_API_BASE_URL/);
  });
});

describe("format", () => {
  it("masks account numbers to the last 4 digits", () => {
    expect(maskAccountNumber("123456789012")).toBe("••••9012");
    expect(maskAccountNumber(null)).toBeNull();
  });

  it("formats money to exactly 2 decimals", () => {
    expect(formatMoney(0.1 + 0.2)).toBe("0.30");
    expect(formatMoney(1_000_000_000)).toBe("1000000000.00");
    expect(formatMoney(999_999_999.99)).toBe("999999999.99");
  });
});

describe("logger", () => {
  it("redacts secrets", () => {
    const lines: string[] = [];
    createLogger("debug", (l) => lines.push(l)).info("login", { accessToken: "abc", password: "p", status: 200 });
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ accessToken: "[REDACTED]", password: "[REDACTED]", status: 200 });
  });
});

describe("errorResult", () => {
  it("hides details of unexpected errors", () => {
    const r = errorResult(new TypeError("Cannot read properties of undefined (reading 'secret')"));
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual({ code: "INTERNAL_ERROR", message: expect.any(String), retryable: false });
    expect(text).not.toContain("secret");
  });

  it("keeps ToolError details", () => {
    const r = errorResult(new ToolError({ code: "X", message: "m", retryable: true, hint: "h" }));
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ code: "X", message: "m", retryable: true, hint: "h" });
  });
});
