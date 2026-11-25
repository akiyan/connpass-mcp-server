import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "./config.js";
import { loadConnpassHtml } from "./node-resource.js";
import { createConfiguredServer } from "./server-factory.js";
import { SearchSessionStore } from "./tools/utils/searchSessionStore.js";

const config = getConfig();
const connpassHtml = loadConnpassHtml();
let cachedServer: McpServer | null = null;

export function createServer(): McpServer {
  return createConfiguredServer({
    config,
    connpassHtml,
    searchSessionStore: new SearchSessionStore(),
  });
}

export function getServer(): McpServer {
  if (!cachedServer) {
    cachedServer = createServer();
  }

  return cachedServer;
}

export const server = getServer();
export { config };
