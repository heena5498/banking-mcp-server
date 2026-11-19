#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTokenProvider } from "./auth.js";
import { BankApiClient } from "./bank/client.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }

  const logger = createLogger(config.logLevel);
  const tokens = createTokenProvider(config);
  const bank = new BankApiClient({ baseUrl: config.baseUrl, tokens, timeoutMs: config.timeoutMs, logger });
  const server = createServer({ bank, logger });

  // Last-resort guards: log and keep serving rather than taking the agent's session down.
  process.on("unhandledRejection", (reason) => logger.error("unhandled rejection", { reason: String(reason) }));
  process.on("uncaughtException", (err) => logger.error("uncaught exception", { error: err.message }));

  await server.connect(new StdioServerTransport());
  logger.info("banking-mcp-server ready", { baseUrl: config.baseUrl, auth: config.token ? "token" : "login" });
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
