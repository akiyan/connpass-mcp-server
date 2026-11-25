import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
} from "@modelcontextprotocol/ext-apps/server";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDeps } from "./types.js";

export const connpassResourceUri = "ui://connpass/app.html";

export function registerConnpassResource(deps: ToolDeps): void {
  const { server, connpassHtml } = deps;
  registerAppResource(
    server,
    "Connpass App",
    connpassResourceUri,
    {
      description: "Interactive Connpass event browser",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async (): Promise<ReadResourceResult> => ({
      contents: [
        {
          uri: connpassResourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: connpassHtml,
          _meta: {
            ui: {
              csp: {
                resourceDomains: [
                  "https://connpass.com",
                  "https://media.connpass.com",
                ],
              },
            },
          },
        },
      ],
    }),
  );
}
