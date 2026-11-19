import type { Config } from "./config.js";
import type { AuthResponse } from "./bank/types.js";
import { ToolError } from "./errors.js";

/** Supplies the bearer token for API calls. */
export interface TokenProvider {
  getToken(): Promise<string>;
  /** Called after a 401. Returns true if a fresh token can be obtained. */
  invalidate(): boolean;
}

/**
 * Uses BANK_API_TOKEN if set. Otherwise logs in with BANK_EMAIL / BANK_PASSWORD, and logs in
 * again after the token is invalidated.
 */
export function createTokenProvider(config: Config, fetchFn: typeof fetch = fetch): TokenProvider {
  let token: string | undefined = config.token;
  let inflight: Promise<string> | undefined;

  async function login(): Promise<string> {
    const creds = config.credentials;
    if (!creds) {
      throw new ToolError({
        code: "AUTH_EXPIRED",
        message: "The banking session token is missing or expired, and no credentials are configured to renew it.",
        retryable: false,
        hint: "Ask the user to update BANK_API_TOKEN in the MCP server configuration.",
      });
    }
    let res: Response;
    try {
      res = await fetchFn(`${config.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(creds),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch {
      throw new ToolError({
        code: "BANK_UNAVAILABLE",
        message: "Could not reach the banking service to sign in.",
        retryable: true,
        hint: "Wait a moment and try again.",
      });
    }
    if (!res.ok) {
      throw new ToolError({
        code: "AUTH_FAILED",
        message: `Sign-in to the banking service failed (HTTP ${res.status}).`,
        retryable: false,
        hint: "Ask the user to check BANK_EMAIL and BANK_PASSWORD in the MCP server configuration.",
      });
    }
    const body = (await res.json()) as AuthResponse;
    return body.accessToken;
  }

  return {
    async getToken() {
      if (token) return token;
      // Share one login between concurrent tool calls.
      inflight ??= login().finally(() => (inflight = undefined));
      token = await inflight;
      return token;
    },
    invalidate() {
      token = undefined;
      return config.credentials !== undefined;
    },
  };
}
