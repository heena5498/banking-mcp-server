import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTokenProvider } from "../src/auth.js";
import { BankApiClient, type BankApiClientOptions } from "../src/bank/client.js";
import type { Config } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { BASE_URL, VALID_TOKEN } from "./mockBank.js";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { baseUrl: BASE_URL, token: VALID_TOKEN, timeoutMs: 500, maxRetries: 2, logLevel: "error", ...overrides };
}

/**
 * Starts the real MCP server and connects a real MCP client to it over an in-memory transport.
 * Retry backoff doesn't really wait: requested delays are recorded in `sleeps` instead.
 */
export async function connect(config: Config = testConfig(), clientOverrides: Partial<BankApiClientOptions> = {}) {
  const sleeps: number[] = [];
  const tokens = createTokenProvider(config);
  const bank = new BankApiClient({
    baseUrl: config.baseUrl,
    tokens,
    timeoutMs: config.timeoutMs,
    retry: { maxRetries: config.maxRetries },
    logger: silentLogger,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...clientOverrides,
  });
  const server = createServer({ bank, logger: silentLogger });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const first = result.content[0];
    const text = first && first.type === "text" ? first.text : "";
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { isError: result.isError === true, body };
  }

  return { client, call, sleeps, close: () => client.close() };
}
