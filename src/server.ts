import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BankApiClient } from "./bank/client.js";
import type { Logger } from "./logger.js";
import { registerReadTools } from "./tools/readTools.js";

export const SERVER_NAME = "banking-mcp-server";
export const SERVER_VERSION = "0.2.0";

export function createServer(deps: { bank: BankApiClient; logger: Logger }): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for the user's accounts at Secure Bank. Use list_accounts to find account IDs. " +
        "Never show full account numbers; the tools return masked numbers.",
    },
  );
  registerReadTools(server, deps);
  return server;
}
