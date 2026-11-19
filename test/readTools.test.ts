import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { connect, testConfig } from "./harness.js";
import { BASE_URL, CHECKING, CREDENTIALS, OTHER_USERS_ACCOUNT_ID, SAVINGS, bankHandlers } from "./mockBank.js";

const mockApi = setupServer(...bankHandlers);
beforeAll(() => mockApi.listen({ onUnhandledFrame: "error" }));
afterEach(() => mockApi.resetHandlers());
afterAll(() => mockApi.close());

describe("tool discovery", () => {
  it("exposes the three read-only tools with read-only annotations", async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_balance", "list_accounts", "list_transactions"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    await close();
  });
});

describe("list_accounts", () => {
  it("returns accounts with masked numbers and 2-decimal balances", async () => {
    const { call, close } = await connect();
    const { isError, body } = await call("list_accounts");
    expect(isError).toBe(false);
    expect(body.accounts).toEqual([
      { accountId: CHECKING.id, accountNumber: "••••1234", type: "CHECKING", balance: "1500.50", status: "ACTIVE" },
      { accountId: SAVINGS.id, accountNumber: "••••5678", type: "SAVINGS", balance: "10000.00", status: "ACTIVE" },
    ]);
    expect(JSON.stringify(body)).not.toContain(CHECKING.accountNumber);
    await close();
  });
});

describe("get_balance", () => {
  it("returns the balance for an owned account", async () => {
    const { call, close } = await connect();
    const { isError, body } = await call("get_balance", { accountId: SAVINGS.id });
    expect(isError).toBe(false);
    expect(body).toEqual({ accountId: SAVINGS.id, accountNumber: "••••5678", balance: "10000.00", status: "ACTIVE" });
    await close();
  });

  it("passes through ACCOUNT_NOT_FOUND as a tool error", async () => {
    const { call, close } = await connect();
    const { isError, body } = await call("get_balance", { accountId: "44444444-4444-4444-8444-444444444444" });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ code: "ACCOUNT_NOT_FOUND", retryable: false });
    await close();
  });

  it("passes through ACCOUNT_ACCESS_DENIED for someone else's account", async () => {
    const { call, close } = await connect();
    const { isError, body } = await call("get_balance", { accountId: OTHER_USERS_ACCOUNT_ID });
    expect(isError).toBe(true);
    expect(body.code).toBe("ACCOUNT_ACCESS_DENIED");
    await close();
  });

  it("rejects a non-UUID accountId without calling the API", async () => {
    const { call, close } = await connect();
    const { isError } = await call("get_balance", { accountId: "../admin/users" });
    expect(isError).toBe(true);
    await close();
  });
});

describe("list_transactions", () => {
  it("defaults to the 10 most recent transactions", async () => {
    const { call, close } = await connect();
    const { isError, body } = await call("list_transactions", { accountId: CHECKING.id });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ page: 0, size: 10, totalTransactions: 25, totalPages: 3, hasMore: true });
    expect(body.transactions).toHaveLength(10);
    expect(body.transactions[0]).toMatchObject({ amount: "10.00", type: "DEPOSIT", from: null, to: "••••1234" });
    expect(body.transactions[1]).toMatchObject({ status: "FAILED", failureReason: "Insufficient funds" });
    await close();
  });

  it("paginates and reports when there are no more pages", async () => {
    const { call, close } = await connect();
    const { body } = await call("list_transactions", { accountId: CHECKING.id, page: 2, size: 10 });
    expect(body.transactions).toHaveLength(5);
    expect(body.hasMore).toBe(false);
    await close();
  });

  it("rejects page sizes over the API maximum of 100", async () => {
    const { call, close } = await connect();
    const { isError } = await call("list_transactions", { accountId: CHECKING.id, size: 500 });
    expect(isError).toBe(true);
    await close();
  });
});

describe("failure handling", () => {
  it("returns BANK_UNAVAILABLE when the API is unreachable, and the server keeps working", async () => {
    mockApi.use(http.get(`${BASE_URL}/api/accounts`, () => HttpResponse.error()));
    const { call, close } = await connect();
    const down = await call("list_accounts");
    expect(down.isError).toBe(true);
    expect(down.body).toMatchObject({ code: "BANK_UNAVAILABLE", retryable: true });

    mockApi.resetHandlers();
    const up = await call("list_accounts");
    expect(up.isError).toBe(false);
    await close();
  });

  it("returns BANK_UNAVAILABLE when the API times out", async () => {
    mockApi.use(
      http.get(`${BASE_URL}/api/accounts`, async () => {
        await new Promise((r) => setTimeout(r, 2000));
        return HttpResponse.json([]);
      }),
    );
    const { call, close } = await connect(testConfig({ timeoutMs: 50 }));
    const { isError, body } = await call("list_accounts");
    expect(isError).toBe(true);
    expect(body).toMatchObject({ code: "BANK_UNAVAILABLE", message: expect.stringContaining("in time") });
    await close();
  });

  it("returns BANK_ERROR on a 5xx without leaking the response body", async () => {
    mockApi.use(http.get(`${BASE_URL}/api/accounts`, () => new HttpResponse("java.lang.NullPointerException at ...", { status: 500 })));
    const { call, close } = await connect();
    const { isError, body } = await call("list_accounts");
    expect(isError).toBe(true);
    expect(body).toMatchObject({ code: "BANK_ERROR", retryable: true });
    expect(JSON.stringify(body)).not.toContain("NullPointerException");
    await close();
  });

  it("returns AUTH_EXPIRED on 401 when no credentials are configured", async () => {
    const { call, close } = await connect(testConfig({ token: "expired-token" }));
    const { isError, body } = await call("list_accounts");
    expect(isError).toBe(true);
    expect(body).toMatchObject({ code: "AUTH_EXPIRED", retryable: false });
    await close();
  });
});

describe("authentication", () => {
  it("logs in with credentials when no token is configured", async () => {
    const { call, close } = await connect(testConfig({ token: undefined, credentials: CREDENTIALS }));
    const { isError, body } = await call("list_accounts");
    expect(isError).toBe(false);
    expect(body.accounts).toHaveLength(2);
    await close();
  });

  it("logs in again and retries once after a 401", async () => {
    const { call, close } = await connect(testConfig({ token: "expired-token", credentials: CREDENTIALS }));
    const { isError } = await call("list_accounts");
    expect(isError).toBe(false);
    await close();
  });

  it("returns AUTH_FAILED for wrong credentials", async () => {
    const { call, close } = await connect(testConfig({ token: undefined, credentials: { ...CREDENTIALS, password: "wrong" } }));
    const { isError, body } = await call("list_accounts");
    expect(isError).toBe(true);
    expect(body.code).toBe("AUTH_FAILED");
    expect(JSON.stringify(body)).not.toContain("wrong");
    await close();
  });
});
