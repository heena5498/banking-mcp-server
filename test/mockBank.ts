import { http, HttpResponse } from "msw";
import type { AccountResponse, TransactionResponse } from "../src/bank/types.js";

/** In-memory stand-in for the Secure Banking API, used by tests (and later by the eval). */

export const BASE_URL = "http://bank.test";
export const VALID_TOKEN = "valid-token";
export const CREDENTIALS = { email: "alice@example.com", password: "Secret123!" };

export const CHECKING: AccountResponse = {
  id: "11111111-1111-4111-8111-111111111111",
  accountNumber: "100000001234",
  type: "CHECKING",
  balance: 1500.5,
  status: "ACTIVE",
  createdAt: "2026-01-01T00:00:00Z",
};

export const SAVINGS: AccountResponse = {
  id: "22222222-2222-4222-8222-222222222222",
  accountNumber: "100000005678",
  type: "SAVINGS",
  balance: 10000,
  status: "ACTIVE",
  createdAt: "2026-01-02T00:00:00Z",
};

/** An account that exists but belongs to someone else. */
export const OTHER_USERS_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";

export const CHECKING_TXNS: TransactionResponse[] = Array.from({ length: 25 }, (_, i) => ({
  id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
  type: i % 3 === 0 ? "DEPOSIT" : "TRANSFER",
  status: i === 1 ? "FAILED" : "COMPLETED",
  amount: 10 + i,
  sourceAccountNumber: i % 3 === 0 ? null : CHECKING.accountNumber,
  destinationAccountNumber: i % 3 === 0 ? CHECKING.accountNumber : "999988887777",
  description: `Txn ${i}`,
  failureReason: i === 1 ? "Insufficient funds" : null,
  createdAt: new Date(Date.UTC(2026, 10, 18 - i)).toISOString(),
}));

const ACCOUNTS = [CHECKING, SAVINGS];

function apiError(status: number, code: string, message: string, path: string) {
  return HttpResponse.json(
    { timestamp: new Date().toISOString(), status, error: "Error", code, message, path },
    { status },
  );
}

function authorized(request: Request): boolean {
  return request.headers.get("Authorization") === `Bearer ${VALID_TOKEN}`;
}

export const bankHandlers = [
  http.post(`${BASE_URL}/api/auth/login`, async ({ request }) => {
    const body = (await request.json()) as { email: string; password: string };
    if (body.email !== CREDENTIALS.email || body.password !== CREDENTIALS.password) {
      return apiError(401, "INVALID_CREDENTIALS", "Invalid email or password", "/api/auth/login");
    }
    return HttpResponse.json({ accessToken: VALID_TOKEN, tokenType: "Bearer", expiresIn: 900, expiresAt: "2026-11-18T23:59:59Z" });
  }),

  http.get(`${BASE_URL}/api/accounts`, ({ request }) => {
    if (!authorized(request)) return apiError(401, "UNAUTHORIZED", "Authentication required", "/api/accounts");
    return HttpResponse.json(ACCOUNTS);
  }),

  http.get(`${BASE_URL}/api/accounts/:id`, ({ request, params }) => {
    const path = new URL(request.url).pathname;
    if (!authorized(request)) return apiError(401, "UNAUTHORIZED", "Authentication required", path);
    if (params.id === OTHER_USERS_ACCOUNT_ID) return apiError(403, "ACCOUNT_ACCESS_DENIED", "You do not own this account", path);
    const acct = ACCOUNTS.find((a) => a.id === params.id);
    return acct ? HttpResponse.json(acct) : apiError(404, "ACCOUNT_NOT_FOUND", "Account not found", path);
  }),

  http.get(`${BASE_URL}/api/accounts/:id/transactions`, ({ request, params }) => {
    const url = new URL(request.url);
    if (!authorized(request)) return apiError(401, "UNAUTHORIZED", "Authentication required", url.pathname);
    if (params.id === OTHER_USERS_ACCOUNT_ID) return apiError(403, "ACCOUNT_ACCESS_DENIED", "You do not own this account", url.pathname);
    const acct = ACCOUNTS.find((a) => a.id === params.id);
    if (!acct) return apiError(404, "ACCOUNT_NOT_FOUND", "Account not found", url.pathname);

    const all = acct.id === CHECKING.id ? CHECKING_TXNS : [];
    const page = Number(url.searchParams.get("page") ?? 0);
    const size = Math.min(Number(url.searchParams.get("size") ?? 20), 100);
    return HttpResponse.json({
      content: all.slice(page * size, page * size + size),
      page,
      size,
      totalElements: all.length,
      totalPages: Math.ceil(all.length / size),
    });
  }),
];
