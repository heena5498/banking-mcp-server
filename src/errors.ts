import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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

/**
 * Converts anything thrown inside a tool into a ToolError. Unknown errors become INTERNAL_ERROR
 * with a generic message, so stack traces and internal details never reach the agent.
 *
 * Phase 3 extends this with the full API error-code table, timeouts and retries.
 */
export function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  return new ToolError({
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred in the banking tool.",
    retryable: false,
  });
}

export function errorResult(err: unknown): CallToolResult {
  const e = toToolError(err);
  return { isError: true, content: [{ type: "text", text: JSON.stringify(e.toJSON()) }] };
}
