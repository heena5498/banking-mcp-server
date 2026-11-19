import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorResult } from "../errors.js";
import type { Logger } from "../logger.js";

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * Runs a tool handler and turns any thrown error into an isError result, so a failing call never
 * crashes the server or leaks internal details.
 */
export async function safely(tool: string, logger: Logger, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    const result = errorResult(err);
    if (!(err instanceof Error && err.name === "ToolError")) {
      logger.error("unexpected tool failure", { tool, error: err instanceof Error ? err.message : String(err) });
    }
    return result;
  }
}
