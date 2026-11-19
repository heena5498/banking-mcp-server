import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseRetryAfter } from "../src/bank/client.js";
import { API_ERROR_POLICY, errors } from "../src/errors.js";
import { connect, testConfig } from "./harness.js";
import { BASE_URL, CHECKING, CREDENTIALS, bankHandlers } from "./mockBank.js";

const mockApi = setupServer(...bankHandlers);
beforeAll(() => mockApi.listen({ onUnhandledFrame: "error" }));
afterEach(() => mockApi.resetHandlers());
afterAll(() => mockApi.close());

const ACCOUNTS_URL = `${BASE_URL}/api/accounts`;

/** Fails the first `failures` requests with `fail()`, then lets them through to the normal mock. */
function flaky(failures: number, fail: () => Response) {
  let calls = 0;
  const handler = http.get(ACCOUNTS_URL, () => {
    calls++;
    if (calls <= failures) return fail();
    return undefined; // fall through to the default handler
  });
  return { handler, calls: () => calls };
}

describe("retries for read tools", () => {
  it("recovers from transient 503s without the agent noticing", async () => {
    const f = flaky(2, () => new HttpResponse(null, { status: 503 }));
    mockApi.use(f.handler);
    const { call, sleeps, close } = await connect();
    const { isError, body } = await call("list_accounts");
    expect(isError).toBe(false);
    expect(body.accounts).toHaveLength(2);
    expect(f.calls()).toBe(3);
    expect(sleeps).toHaveLength(2);
    await close();
  });

  it("recovers from a dropped connection", async () => {
    const f = flaky(1, () => HttpResponse.error());
    mockApi.use(f.handler);
    const { call, close } = await connect();
    expect((await call("list_accounts")).isError).toBe(false);
    expect(f.calls()).toBe(2);
    await close();
  });

  it("gives up after 1 + maxRetries attempts and says how many it tried", async () => {
    const f = flaky(99, () => new HttpResponse(null, { status: 502 }));
    mockApi.use(f.handler);
    const { call, close } = await connect();
    const { isError, body } = await call("list_accounts");
    expect(isError).toBe(true);
    expect(body).toMatchObject({ code: "BANK_ERROR", retryable: true });
    expect(body.message).toContain("tried 3 times");
    expect(body.hint).toMatch(/already retried/);
    expect(f.calls()).toBe(3);
    await close();
  });

  it("respects BANK_API_MAX_RETRIES=0", async () => {
    const f = flaky(99, () => HttpResponse.error());
    mockApi.use(f.handler);
    const { call, close } = await connect(testConfig({ maxRetries: 0 }));
    const { body } = await call("list_accounts");
    expect(body.code).toBe("BANK_UNAVAILABLE");
    expect(f.calls()).toBe(1);
    await close();
  });

  it("uses exponential backoff with jitter, capped", async () => {
    const f = flaky(99, () => new HttpResponse(null, { status: 503 }));
    mockApi.use(f.handler);
    const { call, sleeps, close } = await connect(testConfig({ maxRetries: 5 }), { random: () => 1 });
    await call("list_accounts");
    expect(sleeps).toEqual([250, 500, 1000, 2000, 2000]);
    await close();
  });

  it("waits for a short Retry-After on 429", async () => {
    const f = flaky(1, () => new HttpResponse(null, { status: 429, headers: { "Retry-After": "2" } }));
    mockApi.use(f.handler);
    const { call, sleeps, close } = await connect();
    expect((await call("list_accounts")).isError).toBe(false);
    expect(sleeps).toEqual([2000]);
    await close();
  });

  it("returns RATE_LIMITED instead of waiting out a long Retry-After", async () => {
    const f = flaky(99, () => new HttpResponse(null, { status: 429, headers: { "Retry-After": "60" } }));
    mockApi.use(f.handler);
    const { call, sleeps, close } = await connect();
    const { body } = await call("list_accounts");
    expect(body).toMatchObject({ code: "RATE_LIMITED", retryable: true, hint: expect.stringContaining("60 seconds") });
    expect(sleeps).toEqual([]);
    expect(f.calls()).toBe(1);
    await close();
  });

  it("does not retry 4xx business errors", async () => {
    let calls = 0;
    mockApi.use(
      http.get(ACCOUNTS_URL, () => {
        calls++;
        return HttpResponse.json({ status: 403, code: "FORBIDDEN", message: "Access denied" }, { status: 403 });
      }),
    );
    const { call, close } = await connect();
    const { body } = await call("list_accounts");
    expect(body).toMatchObject({ code: "FORBIDDEN", retryable: false });
    expect(calls).toBe(1);
    await close();
  });

  it("re-login after 401 does not use up a retry", async () => {
    const f = flaky(2, () => new HttpResponse(null, { status: 503 }));
    mockApi.use(f.handler);
    // Expired token → 401 → login → then two 503s → success on the third real attempt.
    const { call, close } = await connect(testConfig({ token: "expired-token", credentials: CREDENTIALS }));
    expect((await call("list_accounts")).isError).toBe(false);
    await close();
  });

  it("retries when the bank is unreachable during login", async () => {
    let loginCalls = 0;
    mockApi.use(
      http.post(`${BASE_URL}/api/auth/login`, () => {
        loginCalls++;
        return loginCalls === 1 ? HttpResponse.error() : undefined;
      }),
    );
    const { call, close } = await connect(testConfig({ token: undefined, credentials: CREDENTIALS }));
    expect((await call("list_accounts")).isError).toBe(false);
    expect(loginCalls).toBe(2);
    await close();
  });
});

describe("API error mapping", () => {
  const cases: [number, string][] = [
    [400, "VALIDATION_FAILED"],
    [400, "INVALID_AMOUNT"],
    [403, "ACCOUNT_ACCESS_DENIED"],
    [404, "ACCOUNT_NOT_FOUND"],
    [409, "CONCURRENT_MODIFICATION"],
    [409, "IDEMPOTENCY_CONFLICT"],
    [422, "INSUFFICIENT_FUNDS"],
    [422, "ACCOUNT_FROZEN"],
    [422, "ACCOUNT_CLOSED"],
  ];

  it.each(cases)("HTTP %i %s → passes the code through with its policy", async (status, code) => {
    mockApi.use(http.get(`${BASE_URL}/api/accounts/:id`, () => HttpResponse.json({ status, code, message: `${code} happened` }, { status })));
    const { call, close } = await connect();
    const { isError, body } = await call("get_balance", { accountId: CHECKING.id });
    expect(isError).toBe(true);
    expect(body).toEqual({ code, message: `${code} happened`, retryable: API_ERROR_POLICY[code]!.retryable, hint: API_ERROR_POLICY[code]!.hint });
    await close();
  });

  it("includes field errors in the message for VALIDATION_FAILED", () => {
    const e = errors.fromApi(400, {
      status: 400,
      code: "VALIDATION_FAILED",
      message: "Validation failed",
      fieldErrors: [{ field: "amount", message: "must be greater than 0" }],
    });
    expect(e.message).toBe("Validation failed: amount must be greater than 0");
  });

  it("falls back on the HTTP status when there is no recognisable body", async () => {
    mockApi.use(http.get(ACCOUNTS_URL, () => new HttpResponse("<html>Forbidden</html>", { status: 403 })));
    const { call, close } = await connect();
    const { body } = await call("list_accounts");
    expect(body).toMatchObject({ code: "FORBIDDEN", retryable: false, hint: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain("html");
    await close();
  });

  it("passes through an unknown API code with a generic hint", () => {
    const e = errors.fromApi(422, { status: 422, code: "SOMETHING_NEW", message: "New rule" });
    expect(e.toJSON()).toMatchObject({ code: "SOMETHING_NEW", retryable: false, hint: expect.any(String) });
  });

  it("truncates very long API messages", () => {
    const e = errors.fromApi(400, { status: 400, code: "VALIDATION_FAILED", message: "x".repeat(5000) });
    expect(e.message.length).toBeLessThanOrEqual(300);
  });

  it("returns BANK_ERROR when a 200 response isn't valid JSON", async () => {
    mockApi.use(http.get(ACCOUNTS_URL, () => new HttpResponse("<html>Login page</html>", { status: 200 })));
    const { call, close } = await connect();
    const { body } = await call("list_accounts");
    expect(body).toMatchObject({ code: "BANK_ERROR", message: expect.stringContaining("could not read") });
    await close();
  });

  it("every policy has a hint", () => {
    for (const [code, p] of Object.entries(API_ERROR_POLICY)) expect(p.hint, code).not.toBe("");
  });
});

describe("cancellation", () => {
  it("stops retrying when the MCP client cancels the call", async () => {
    let calls = 0;
    mockApi.use(
      http.get(ACCOUNTS_URL, () => {
        calls++;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    const controller = new AbortController();
    let serverSawAbort = false;
    const { client, close } = await connect(testConfig(), {
      // During the first backoff, cancel from the client side, then wait until the server-side
      // signal (delivered via notifications/cancelled) aborts. If cancellation didn't propagate,
      // this would hang and the test would time out.
      sleep: (_ms, signal) =>
        new Promise((_, reject) => {
          signal!.addEventListener("abort", () => {
            serverSawAbort = true;
            reject(signal!.reason);
          });
          controller.abort();
        }),
    });
    await expect(client.callTool({ name: "list_accounts", arguments: {} }, undefined, { signal: controller.signal })).rejects.toThrow();
    await vi.waitFor(() => expect(serverSawAbort).toBe(true));
    expect(calls).toBe(1);
    await close();
  });
});

describe("invalid arguments", () => {
  // The SDK validates arguments against the tool schema before our handler runs, and reports
  // failures as plain text rather than our JSON shape. This test pins that behaviour so we notice
  // if an SDK upgrade changes it.
  it("are reported by the SDK as an error that names the bad field", async () => {
    const { client, close } = await connect();
    const result = await client.callTool({ name: "get_balance", arguments: { accountId: "not-a-uuid" } });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/Input validation error/);
    expect(text).toContain("accountId");
    await close();
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
