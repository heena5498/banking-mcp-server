import type { TokenProvider } from "../auth.js";
import { ToolError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { AccountResponse, ApiErrorBody, PageResponse, TransactionResponse } from "./types.js";

export interface BankApiClientOptions {
  baseUrl: string;
  tokens: TokenProvider;
  timeoutMs: number;
  logger: Logger;
  fetchFn?: typeof fetch;
}

// Typed wrapper around the Secure Banking API. Every failure is thrown as a ToolError.

export class BankApiClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: BankApiClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  listAccounts(): Promise<AccountResponse[]> {
    return this.get<AccountResponse[]>("/api/accounts");
  }

  getAccount(accountId: string): Promise<AccountResponse> {
    return this.get<AccountResponse>(`/api/accounts/${encodeURIComponent(accountId)}`);
  }

  listTransactions(accountId: string, page: number, size: number): Promise<PageResponse<TransactionResponse>> {
    const q = new URLSearchParams({ page: String(page), size: String(size) });
    return this.get<PageResponse<TransactionResponse>>(`/api/accounts/${encodeURIComponent(accountId)}/transactions?${q}`);
  }

  private async get<T>(path: string): Promise<T> {
    let res = await this.send("GET", path);
    // Token expired mid-session: log in again once, if credentials are configured.
    if (res.status === 401 && this.opts.tokens.invalidate()) {
      res = await this.send("GET", path);
    }
    if (!res.ok) throw await this.apiError(res, path);
    return (await res.json()) as T;
  }

  private async send(method: string, path: string): Promise<Response> {
    const token = await this.opts.tokens.getToken();
    const started = Date.now();
    try {
      const res = await this.fetchFn(`${this.opts.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      this.opts.logger.debug("bank api", { method, path: redactPath(path), status: res.status, ms: Date.now() - started });
      return res;
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      this.opts.logger.warn("bank api unreachable", { method, path: redactPath(path), timedOut, ms: Date.now() - started });
      throw new ToolError({
        code: "BANK_UNAVAILABLE",
        message: timedOut ? "The banking service did not respond in time." : "Could not reach the banking service.",
        retryable: true,
        hint: "Tell the user the bank is temporarily unavailable and offer to try again shortly.",
      });
    }
  }

  private async apiError(res: Response, path: string): Promise<ToolError> {
    let body: Partial<ApiErrorBody> = {};
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      // Non-JSON error body (e.g. a proxy error page). Fall back to the status code.
    }
    this.opts.logger.info("bank api error", { path: redactPath(path), status: res.status, code: body.code });

    if (res.status === 401) {
      return new ToolError({
        code: "AUTH_EXPIRED",
        message: "The banking session has expired.",
        retryable: false,
        hint: "Ask the user to refresh BANK_API_TOKEN in the MCP server configuration.",
      });
    }
    if (res.status >= 500) {
      return new ToolError({
        code: "BANK_ERROR",
        message: "The banking service had an internal error.",
        retryable: true,
        hint: "Try again shortly. If it keeps failing, tell the user the bank is having problems.",
      });
    }
    return new ToolError({
      code: body.code ?? `HTTP_${res.status}`,
      message: body.message ?? `The banking service rejected the request (HTTP ${res.status}).`,
      retryable: false,
    });
  }
}

/** Removes UUIDs from paths before logging, so logs don't link a session to specific accounts. */
function redactPath(path: string): string {
  return path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
}
