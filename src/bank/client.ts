import type { TokenProvider } from "../auth.js";
import { ToolError, errors } from "../errors.js";
import type { Logger } from "../logger.js";
import type { AccountResponse, ApiErrorBody, PageResponse, TransactionResponse } from "./types.js";

export interface RetryPolicy {
  /** Extra attempts after the first one, for retryable failures. Only used for reads. */
  maxRetries: number;
  /** Backoff before retry n (1-based) is a random delay in [0, min(maxDelayMs, baseDelayMs * 2^(n-1))]. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** A Retry-After longer than this is not waited out; the error is returned to the agent instead. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 2000, maxRetryAfterMs: 5000 };

export interface BankApiClientOptions {
  baseUrl: string;
  tokens: TokenProvider;
  timeoutMs: number;
  logger: Logger;
  retry?: Partial<RetryPolicy>;
  fetchFn?: typeof fetch;
  /** Injected in tests so retries don't really wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface CallOptions {
  /** Aborts the request (and any pending retries) when the MCP client cancels the tool call. */
  signal?: AbortSignal;
}

interface RequestSpec {
  method: "GET" | "POST";
  path: string;
  /**
   * Retry transient failures. True for reads. Must be false for anything that moves money: a
   * write is only ever re-sent deliberately, with the same Idempotency-Key.
   */
  retry: boolean;
  signal?: AbortSignal;
}

/** Statuses worth retrying: rate limiting and transient server/gateway failures. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

type Attempt = { kind: "response"; res: Response } | { kind: "network"; timedOut: boolean };

/** Typed wrapper around the Secure Banking API. Every failure is thrown as a ToolError. */
export class BankApiClient {
  private readonly fetchFn: typeof fetch;
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly opts: BankApiClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.retry = { ...DEFAULT_RETRY_POLICY, ...opts.retry };
    this.sleep = opts.sleep ?? abortableSleep;
    this.random = opts.random ?? Math.random;
  }

  listAccounts(call: CallOptions = {}): Promise<AccountResponse[]> {
    return this.request({ method: "GET", path: "/api/accounts", retry: true, ...call });
  }

  getAccount(accountId: string, call: CallOptions = {}): Promise<AccountResponse> {
    return this.request({ method: "GET", path: `/api/accounts/${encodeURIComponent(accountId)}`, retry: true, ...call });
  }

  listTransactions(accountId: string, page: number, size: number, call: CallOptions = {}): Promise<PageResponse<TransactionResponse>> {
    const q = new URLSearchParams({ page: String(page), size: String(size) });
    return this.request({ method: "GET", path: `/api/accounts/${encodeURIComponent(accountId)}/transactions?${q}`, retry: true, ...call });
  }

  private async request<T>(spec: RequestSpec): Promise<T> {
    const maxAttempts = spec.retry ? 1 + this.retry.maxRetries : 1;
    const logPath = redactPath(spec.path);
    let reauthenticated = false;

    for (let attempt = 1; ; attempt++) {
      if (spec.signal?.aborted) throw errors.cancelled();
      const outcome = await this.attempt(spec);

      if (outcome.kind === "network") {
        if (attempt < maxAttempts) {
          await this.backoff(attempt, undefined, spec, { reason: outcome.timedOut ? "timeout" : "network" });
          continue;
        }
        throw errors.unavailable(outcome.timedOut, attempt);
      }

      const res = outcome.res;

      // Token expired mid-session: log in again once, if credentials are configured. This doesn't
      // count as a retry: the request never reached the business logic.
      if (res.status === 401 && !reauthenticated && this.opts.tokens.invalidate()) {
        reauthenticated = true;
        attempt--;
        continue;
      }

      if (res.ok) {
        try {
          return (await res.json()) as T;
        } catch {
          this.opts.logger.warn("bank api unreadable response", { method: spec.method, path: logPath, status: res.status });
          throw errors.badResponse();
        }
      }

      if (RETRYABLE_STATUSES.has(res.status)) {
        const retryAfterMs = parseRetryAfter(res.headers.get("Retry-After"));
        const canWait = retryAfterMs === undefined || retryAfterMs <= this.retry.maxRetryAfterMs;
        if (attempt < maxAttempts && canWait) {
          await res.body?.cancel();
          await this.backoff(attempt, retryAfterMs, spec, { reason: `http ${res.status}` });
          continue;
        }
        this.opts.logger.warn("bank api giving up", { method: spec.method, path: logPath, status: res.status, attempts: attempt });
        if (res.status === 429) throw errors.rateLimited(retryAfterMs === undefined ? undefined : Math.ceil(retryAfterMs / 1000));
        throw errors.serverError(res.status, attempt);
      }

      if (res.status === 401) throw errors.authExpired();

      const body = await readErrorBody(res);
      this.opts.logger.info("bank api error", { method: spec.method, path: logPath, status: res.status, code: body.code });
      throw errors.fromApi(res.status, body);
    }
  }

  /** One HTTP round trip. Network failures and timeouts are returned, not thrown, so the caller can retry them. */
  private async attempt(spec: RequestSpec): Promise<Attempt> {
    const started = Date.now();
    const logPath = redactPath(spec.path);
    try {
      const token = await this.opts.tokens.getToken();
      const timeout = AbortSignal.timeout(this.opts.timeoutMs);
      const res = await this.fetchFn(`${this.opts.baseUrl}${spec.path}`, {
        method: spec.method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: spec.signal ? AbortSignal.any([timeout, spec.signal]) : timeout,
      });
      this.opts.logger.debug("bank api", { method: spec.method, path: logPath, status: res.status, ms: Date.now() - started });
      return { kind: "response", res };
    } catch (err) {
      if (spec.signal?.aborted) throw errors.cancelled();
      // Login failed because the bank was unreachable: treat it like any other network failure.
      if (err instanceof ToolError && err.code !== "BANK_UNAVAILABLE") throw err;
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      this.opts.logger.warn("bank api unreachable", { method: spec.method, path: logPath, timedOut, ms: Date.now() - started });
      return { kind: "network", timedOut };
    }
  }

  private async backoff(attempt: number, retryAfterMs: number | undefined, spec: RequestSpec, why: { reason: string }): Promise<void> {
    const exp = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
    // Full jitter, so many clients recovering from the same outage don't retry in lockstep.
    const delayMs = retryAfterMs ?? Math.round(this.random() * exp);
    this.opts.logger.warn("bank api retrying", { method: spec.method, path: redactPath(spec.path), attempt, delayMs, ...why });
    try {
      await this.sleep(delayMs, spec.signal);
    } catch {
      throw errors.cancelled();
    }
  }
}

async function readErrorBody(res: Response): Promise<Partial<ApiErrorBody>> {
  try {
    const body: unknown = await res.json();
    return body && typeof body === "object" ? (body as Partial<ApiErrorBody>) : {};
  } catch {
    return {}; // Non-JSON error body (e.g. a proxy error page): fall back to the status code.
  }
}

/** Parses Retry-After as delta-seconds or an HTTP date. Returns milliseconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Removes UUIDs from paths before logging, so logs don't link a session to specific accounts. */
function redactPath(path: string): string {
  return path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
}
