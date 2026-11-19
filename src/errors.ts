import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ApiErrorBody } from "./bank/types.js";

/** The single error shape every tool returns to the agent (see docs/architecture.md). */
export interface ToolErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  hint?: string;
}

export class ToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly hint?: string;

  constructor(body: ToolErrorBody) {
    super(body.message);
    this.name = "ToolError";
    this.code = body.code;
    this.retryable = body.retryable;
    this.hint = body.hint;
  }

  toJSON(): ToolErrorBody {
    return { code: this.code, message: this.message, retryable: this.retryable, ...(this.hint ? { hint: this.hint } : {}) };
  }
}

interface ErrorPolicy {
  retryable: boolean;
  hint: string;
}

/**
 * What the agent should do for each Secure Banking API error code. The API's own code is passed
 * through (it's more specific than anything we'd invent); this table adds retryability and a hint.
 */
export const API_ERROR_POLICY: Record<string, ErrorPolicy> = {
  // 400: the request was wrong; retrying it unchanged won't help.
  VALIDATION_FAILED: { retryable: false, hint: "Fix the fields named in the message and try again." },
  MALFORMED_REQUEST: { retryable: false, hint: "The request was malformed. Check the arguments and try again." },
  INVALID_AMOUNT: {
    retryable: false,
    hint: "Amounts must be greater than 0, have at most 2 decimal places, and be at most 1,000,000,000.00. Ask the user for a valid amount.",
  },
  INVALID_TRANSFER: {
    retryable: false,
    hint: "Check that the source and destination are different accounts and the destination is a 12-digit account number.",
  },
  IDEMPOTENCY_KEY_REQUIRED: { retryable: false, hint: "This is a fault in the banking tool, not the user's request. Tell the user the operation could not be submitted." },
  IDEMPOTENCY_KEY_INVALID: { retryable: false, hint: "This is a fault in the banking tool, not the user's request. Tell the user the operation could not be submitted." },
  // 403
  FORBIDDEN: { retryable: false, hint: "The signed-in user isn't allowed to do this. Tell the user; don't retry." },
  ACCOUNT_ACCESS_DENIED: {
    retryable: false,
    hint: "This account doesn't belong to the signed-in user. Call list_accounts to see the user's own accounts.",
  },
  // 404
  ACCOUNT_NOT_FOUND: {
    retryable: false,
    hint: "Call list_accounts to get valid account IDs, or ask the user to check the account number.",
  },
  USER_NOT_FOUND: { retryable: false, hint: "The user could not be found. Tell the user." },
  NOT_FOUND: { retryable: false, hint: "The requested item does not exist." },
  // 409
  CONCURRENT_MODIFICATION: {
    retryable: true,
    hint: "Another operation changed this account at the same moment. It is safe to try again.",
  },
  IDEMPOTENCY_CONFLICT: {
    retryable: false,
    hint: "This operation was already submitted with different details. Don't retry; start a new request.",
  },
  CONFLICT: { retryable: false, hint: "The request conflicts with the current state. Tell the user." },
  // 422: business rules.
  INSUFFICIENT_FUNDS: {
    retryable: false,
    hint: "Tell the user the available balance (use get_balance) and ask whether they want to use a smaller amount.",
  },
  ACCOUNT_FROZEN: { retryable: false, hint: "The account is frozen, so no money can move in or out. Tell the user to contact the bank." },
  ACCOUNT_CLOSED: { retryable: false, hint: "The account is closed. Ask the user to choose a different account." },
};

/** Used when the API returns a status without a recognised code (e.g. from a proxy). */
const STATUS_FALLBACK: Record<number, { code: string } & ErrorPolicy> = {
  400: { code: "INVALID_REQUEST", retryable: false, hint: "Check the arguments and try again." },
  403: { code: "FORBIDDEN", retryable: false, hint: "The signed-in user isn't allowed to do this. Tell the user; don't retry." },
  404: { code: "NOT_FOUND", retryable: false, hint: "The requested item does not exist." },
  409: { code: "CONFLICT", retryable: false, hint: "The request conflicts with the current state. Tell the user." },
  422: { code: "REQUEST_REJECTED", retryable: false, hint: "The bank rejected the request. Tell the user why." },
};

const MAX_MESSAGE_LENGTH = 300;

function truncate(s: string): string {
  return s.length > MAX_MESSAGE_LENGTH ? `${s.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : s;
}

export const errors = {
  unavailable(timedOut: boolean, attempts: number): ToolError {
    const what = timedOut ? "did not respond in time" : "could not be reached";
    return new ToolError({
      code: "BANK_UNAVAILABLE",
      message: `The banking service ${what}${attempts > 1 ? ` (tried ${attempts} times)` : ""}.`,
      retryable: true,
      hint: "Tell the user the bank is temporarily unavailable. The tool already retried, so wait before trying again.",
    });
  },

  serverError(status: number, attempts: number): ToolError {
    return new ToolError({
      code: "BANK_ERROR",
      message: `The banking service had an internal error (HTTP ${status}${attempts > 1 ? `, tried ${attempts} times` : ""}).`,
      retryable: true,
      hint: "Tell the user the bank is having problems. The tool already retried, so wait before trying again.",
    });
  },

  rateLimited(retryAfterSeconds: number | undefined): ToolError {
    return new ToolError({
      code: "RATE_LIMITED",
      message: "The banking service is receiving too many requests.",
      retryable: true,
      hint: retryAfterSeconds
        ? `Wait at least ${retryAfterSeconds} seconds before trying again.`
        : "Wait a little before trying again.",
    });
  },

  authExpired(): ToolError {
    return new ToolError({
      code: "AUTH_EXPIRED",
      message: "The banking session has expired.",
      retryable: false,
      hint: "Ask the user to refresh BANK_API_TOKEN (or set BANK_EMAIL and BANK_PASSWORD) in the MCP server configuration.",
    });
  },

  badResponse(): ToolError {
    return new ToolError({
      code: "BANK_ERROR",
      message: "The banking service returned a response the tool could not read.",
      retryable: true,
      hint: "Try once more. If it keeps failing, tell the user the bank is having problems.",
    });
  },

  cancelled(): ToolError {
    return new ToolError({ code: "CANCELLED", message: "The request was cancelled.", retryable: false });
  },

  /** Translates a 4xx API error body into a ToolError with the policy for its code. */
  fromApi(status: number, body: Partial<ApiErrorBody>): ToolError {
    const fallback = STATUS_FALLBACK[status];
    const policy = (body.code ? API_ERROR_POLICY[body.code] : undefined) ?? fallback;
    const code = body.code ?? fallback?.code ?? `HTTP_${status}`;

    let message = body.message || `The banking service rejected the request (HTTP ${status}).`;
    if (body.fieldErrors?.length) {
      message += `: ${body.fieldErrors.map((f) => `${f.field} ${f.message}`).join("; ")}`;
    }

    return new ToolError({
      code,
      message: truncate(message),
      retryable: policy?.retryable ?? false,
      hint: policy?.hint ?? "Tell the user the bank rejected the request.",
    });
  },
};

/**
 * Converts anything thrown inside a tool into a ToolError. Unknown errors become INTERNAL_ERROR
 * with a generic message, so stack traces and internal details never reach the agent.
 */
export function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  return new ToolError({
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred in the banking tool.",
    retryable: false,
    hint: "Tell the user something went wrong. Don't retry the same request.",
  });
}

export function errorResult(err: unknown): CallToolResult {
  const e = toToolError(err);
  return { isError: true, content: [{ type: "text", text: JSON.stringify(e.toJSON()) }] };
}
