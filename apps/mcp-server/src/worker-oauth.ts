import {
  AuthorizationError,
  OAuthAuthorizationServer,
  OAuthError,
} from "@cloudflare/workers-oauth-provider";
import type { ExecutionContext, KVNamespace } from "@cloudflare/workers-types";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface OAuthEnv {
  OAUTH_KV?: KVNamespace;
  MCP_OAUTH_ORIGIN?: string;
}

const scope = "connpass:read";
const owner = "owner";
const authorizePath = "/oauth/authorize";
const resourceMetadataPath = "/.well-known/oauth-protected-resource";
const serverMetadataPath = "/.well-known/oauth-authorization-server";
const chatgptCallback =
  /^https:\/\/chatgpt\.com\/(?:connector_platform_oauth_redirect|connector\/oauth\/[A-Za-z0-9_-]+)$/;

export function equalSecret(left: string, right: string): boolean {
  const digest = (key: string) => createHash("sha256").update(key).digest();
  return timingSafeEqual(digest(left), digest(right));
}

function ownerBinding(key: string, resource: string): string {
  return createHmac("sha256", key)
    .update(`connpass-mcp-owner:${resource}`)
    .digest("base64url");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] ?? c,
  );
}

export function configureOAuth(env: OAuthEnv, apiKey: string | undefined) {
  const origin = env.MCP_OAUTH_ORIGIN;
  if (!origin || !env.OAUTH_KV || !apiKey || apiKey.length < 32)
    return undefined;
  const ownerKey = apiKey;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.origin !== origin) return undefined;

  const resource = `${origin}/mcp`;
  const binding = ownerBinding(apiKey, resource);
  const server = new OAuthAuthorizationServer<OAuthEnv>({
    issuer: origin,
    resources: [resource],
    authorizeEndpoint: authorizePath,
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: false,
    scopesSupported: [scope],
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 3600,
    clientRegistrationCallback({ clientMetadata: { redirect_uris } }) {
      if (
        !Array.isArray(redirect_uris) ||
        !redirect_uris.length ||
        !redirect_uris.every(
          (uri: unknown) =>
            typeof uri === "string" && chatgptCallback.test(uri),
        )
      ) {
        return {
          code: "invalid_redirect_uri",
          description: "Only ChatGPT callbacks are allowed",
        };
      }
    },
    tokenExchangeCallback({ props }) {
      if (
        typeof props?.ownerBinding !== "string" ||
        !equalSecret(props.ownerBinding, binding)
      ) {
        throw new OAuthError("invalid_grant", {
          description: "Owner authorization expired",
        });
      }
    },
  });

  async function authorize(request: Request): Promise<Response> {
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'",
      // no-referrer turns the browser's same-origin form POST Origin into null.
      // Keep the real Origin for CSRF validation without sending a referrer to ChatGPT.
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
    const reply = (message: string, status: number) =>
      new Response(message, { status, headers });
    const helpers = server.getOAuthApi(env);
    try {
      if (request.method === "GET") {
        const auth = await helpers.parseAuthRequest(request);
        if (!chatgptCallback.test(auth.redirectUri))
          return reply("Invalid ChatGPT callback", 400);
        const consent = await helpers.beginConsent(auth);
        for (const [name, value] of consent.headers) {
          if (name.toLowerCase() === "set-cookie") headers.append(name, value);
        }
        headers.set("Content-Type", "text/html; charset=utf-8");
        return reply(
          `<!doctype html><html lang="ja"><meta charset="utf-8">
<title>connpass MCP を ChatGPT に接続</title><h1>connpass MCP を ChatGPT に接続</h1>
<p>ChatGPT にイベント検索を許可します。自分で開始した接続の場合だけ承認してください。</p>
<form method="post" action="${authorizePath}">
<input type="hidden" name="handle" value="${escapeHtml(consent.handle)}">
<label>Worker の MCP_API_KEY <input name="ownerKey" type="password" autocomplete="off" required></label>
<button type="submit">接続を承認</button></form></html>`,
          200,
        );
      }
      if (request.method !== "POST") {
        headers.set("Allow", "GET, POST");
        return reply("Method Not Allowed", 405);
      }
      if (request.headers.get("Origin") !== origin)
        return reply("Invalid approval origin", 403);
      if (
        !request.headers
          .get("Content-Type")
          ?.startsWith("application/x-www-form-urlencoded")
      ) {
        return reply("Invalid approval form", 415);
      }
      const form = new URLSearchParams(await request.text());
      const handle = form.get("handle");
      const presentedKey = form.get("ownerKey");
      if (!handle || !presentedKey || !equalSecret(presentedKey, ownerKey)) {
        return reply(
          "Owner key did not match. Return to the approval form and try again.",
          403,
        );
      }
      const approved = await helpers.approveConsent(request, handle, {
        scope: [scope],
      });
      const { redirectTo } = await helpers.completeAuthorization({
        request: approved.request,
        userId: owner,
        metadata: {},
        scope: approved.request.scope,
        props: { ownerBinding: binding },
      });
      for (const [name, value] of approved.headers) {
        if (name.toLowerCase() === "set-cookie") headers.append(name, value);
      }
      headers.set("Location", redirectTo);
      return reply("Redirecting to ChatGPT", 303);
    } catch (error) {
      if (error instanceof AuthorizationError)
        return reply(
          "Invalid or expired authorization request. Start again in ChatGPT.",
          400,
        );
      // In particular, do not log credentials or the form body when storage fails.
      return reply("OAuth authorization is temporarily unavailable", 503);
    }
  }

  return {
    challenge: `Bearer resource_metadata="${origin}${resourceMetadataPath}/mcp", scope="${scope}"`,
    async route(
      request: Request,
      ctx: ExecutionContext,
    ): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (url.origin !== origin) return undefined;
      if (url.pathname === authorizePath) return authorize(request);
      if (
        request.method === "GET" &&
        [resourceMetadataPath, `${resourceMetadataPath}/mcp`].includes(
          url.pathname,
        )
      ) {
        return Response.json(
          {
            resource,
            authorization_servers: [origin],
            scopes_supported: [scope],
            bearer_methods_supported: ["header"],
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      if (
        [
          serverMetadataPath,
          "/oauth/register",
          "/oauth/token",
          "/oauth/token/revoke",
        ].includes(url.pathname)
      ) {
        return server.fetch(request, env, ctx);
      }
      return undefined;
    },
    async authenticate(request: Request, token: string): Promise<boolean> {
      if (new URL(request.url).origin !== origin) return false;
      const identity = await server.validateToken<{ ownerBinding?: string }>(
        resource,
        token,
        env,
      );
      return Boolean(
        identity?.userId === owner &&
          identity.scope.includes(scope) &&
          typeof identity.props?.ownerBinding === "string" &&
          equalSecret(identity.props.ownerBinding, binding),
      );
    },
  };
}
