import type {
  DurableObjectNamespace,
  ExecutionContext,
} from "@cloudflare/workers-types";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import connpassHtml from "../../../packages/connpass-ui/dist/mcp-app.html";
import { getConfig } from "./config.js";
import { createConfiguredServer } from "./server-factory.js";
import { configureOAuth, equalSecret, type OAuthEnv } from "./worker-oauth.js";
import { WorkerSearchSessionStore } from "./worker-search-sessions.js";

export { SearchSessionObject } from "./worker-search-sessions.js";

interface Env extends OAuthEnv {
  [key: string]: unknown;
  SEARCH_SESSIONS: DurableObjectNamespace;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const headers = new Headers({ "Cache-Control": "no-store" });
    const config = getConfig(
      [],
      Object.fromEntries(
        Object.entries(env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    );
    const apiKey = config.apiKey?.trim();
    const ready = Boolean(apiKey && config.connpassApiKey?.trim());

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json(
        { status: ready ? "ok" : "unavailable" },
        {
          status: ready ? 200 : 503,
          headers,
        },
      );
    }
    const oauth = ready ? configureOAuth(env, apiKey) : undefined;
    if (url.pathname !== "/mcp") {
      return (
        (await oauth?.route(request, ctx)) ??
        new Response("Not Found", { status: 404, headers })
      );
    }

    headers.set("Vary", "Origin");
    const origin = request.headers.get("Origin");
    const allowedOrigins =
      typeof env.MCP_ALLOWED_ORIGINS === "string" ? config.allowedOrigins : [];
    if (origin !== null) {
      if (origin !== url.origin && !allowedOrigins.includes(origin)) {
        return new Response("Forbidden: Invalid Origin", {
          status: 403,
          headers,
        });
      }
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set(
        "Access-Control-Expose-Headers",
        "MCP-Protocol-Version, WWW-Authenticate",
      );
    }
    if (request.method === "OPTIONS" && origin) {
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-API-Key, MCP-Protocol-Version, MCP-Session-Id",
      );
      return new Response(null, { status: 204, headers });
    }
    if (!ready || !apiKey) {
      return new Response("Worker secrets are not configured", {
        status: 503,
        headers,
      });
    }

    const bearer = request.headers
      .get("Authorization")
      ?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const apiHeader = request.headers.get("X-API-Key");
    const token = apiHeader ?? bearer;
    let authenticated = Boolean(token && equalSecret(token, apiKey));
    if (!authenticated && apiHeader === null && bearer && oauth) {
      try {
        authenticated = await oauth.authenticate(request, bearer);
      } catch {
        return new Response("Authentication temporarily unavailable", {
          status: 503,
          headers,
        });
      }
    }
    if (!authenticated) {
      headers.set("WWW-Authenticate", oauth?.challenge ?? "Bearer");
      return new Response("Unauthorized", { status: 401, headers });
    }
    if (request.method !== "POST") {
      headers.set("Allow", "POST, OPTIONS");
      return new Response("Method Not Allowed", { status: 405, headers });
    }

    // An isolate may handle just one request. Keep transport and I/O state
    // request-local and use JSON responses so closing the server cannot cancel SSE.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createConfiguredServer({
      config,
      connpassHtml,
      searchSessionStore: new WorkerSearchSessionStore(env.SEARCH_SESSIONS),
      worker: true,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      for (const [name, value] of headers) response.headers.set(name, value);
      return response;
    } finally {
      await server.close();
    }
  },
};
