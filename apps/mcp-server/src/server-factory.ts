import { ConnpassClient } from "@kajidog/connpass-api-client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "./config.js";
import { registerAllTools } from "./tools/index.js";
import { setDisabledTools } from "./tools/utils/registration.js";
import type { SearchSessionStorage } from "./tools/utils/searchSessionStore.js";
import type { ToolDeps } from "./tools/utils/types.js";

interface ServerOptions {
  config: ServerConfig;
  connpassHtml: string;
  searchSessionStore: SearchSessionStorage;
  worker?: boolean;
}

function createUnavailableConnpassClient(): ConnpassClient {
  const message =
    "CONNPASS_API_KEY is required to use Connpass API tools. Set the environment variable or pass --connpass-api-key.";

  return new Proxy({} as ConnpassClient, {
    get(_target, property) {
      if (property === "then") {
        return undefined;
      }

      if (typeof property === "symbol") {
        return undefined;
      }

      return async () => {
        throw new Error(message);
      };
    },
  });
}

function createConnpassClient(
  config: ServerConfig,
  worker: boolean,
): ConnpassClient {
  if (!config.connpassApiKey?.trim()) {
    return createUnavailableConnpassClient();
  }

  return new ConnpassClient({
    apiKey: config.connpassApiKey,
    rateLimitEnabled: config.rateLimitEnabled,
    rateLimitDelay: config.rateLimitDelayMs,
    ...(worker && {
      enablePresentationCache: false,
      adapter: "fetch" as const,
    }),
  });
}

/**
 * McpServer を作成しツールを登録するファクトリ関数
 * HTTPモードではセッションごとに新しいインスタンスが必要
 */
export function createConfiguredServer({
  config,
  connpassHtml,
  searchSessionStore,
  worker = false,
}: ServerOptions): McpServer {
  const server = new McpServer({
    name: "connpass-mcp-server",
    version: "0.3.0",
    description: "Connpass event search and browsing MCP server with Apps UI",
  });

  const connpassClient = createConnpassClient(config, worker);

  const deps: ToolDeps = {
    server,
    connpassClient,
    config,
    searchSessionStore,
    connpassHtml,
  };

  setDisabledTools(config.disableTools);
  registerAllTools(deps);

  return server;
}
