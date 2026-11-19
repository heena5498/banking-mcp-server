import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTokenProvider } from "../src/auth.js";
import { BankApiClient } from "../src/bank/client.js";
import type { Config } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { BASE_URL, VALID_TOKEN } from "./mockBank.js";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { baseUrl: BASE_URL, token: VALID_TOKEN, timeoutMs: 500, logLevel: "error", ...overrides };
}

/** Starts the real MCP server and connects a real MCP client to it over an in-memory transport. */
export async function connect(config: Config = testConfig()) {
  const tokens = createTokenProvider(config);
  const bank = new BankApiClient({ baseUrl: config.baseUrl, tokens, timeoutMs: config.timeoutMs, logger: silentLogger });
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

  return { client, call, close: () => client.close() };
}
