import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

// First run pnpm worker:check from apps/mcp-server to produce the dry-run bundle.
const dir = fileURLToPath(new URL("../.wrangler/worker-check/", import.meta.url));
const origin = "https://mcp.example.test";
const resource = `${origin}/mcp`;
const scope = "connpass:read";
const ownerKey = "local-test-token-with-at-least-32-chars";
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const evilOrigin = "https://untrusted.example";
const worker = new Miniflare({
  scriptPath: `${dir}worker.js`,
  modulesRoot: dir,
  modules: true,
  modulesRules: [{ type: "Text", include: ["**/*.html"] }],
  compatibilityDate: "2026-05-01",
  compatibilityFlags: ["nodejs_compat"],
  kvNamespaces: ["OAUTH_KV"],
  bindings: { MCP_OAUTH_ORIGIN: origin, CONNPASS_API_KEY: "dummy", MCP_API_KEY: ownerKey },
  durableObjects: {
    SEARCH_SESSIONS: { className: "SearchSessionObject", useSQLite: true },
  },
  outboundService(request) {
    assert.fail(`Unexpected outbound request to ${new URL(request.url).origin}`);
  },
});

function fetchWorker(path, init) {
  return worker.dispatchFetch(new URL(path, origin).href, { ...init, redirect: "manual" });
}

async function expectJson(response, status, label) {
  assert.equal(response.status, status, label);
  assert.match(response.headers.get("Content-Type") ?? "", /application\/json/i, label);
  return response.json();
}

function register(uri) {
  return fetchWorker("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Worker OAuth smoke test",
      redirect_uris: [uri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope,
    }),
  });
}

function listTools(accessToken) {
  return fetchWorker("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

async function assertCanListTools(accessToken, label) {
  const payload = await expectJson(await listTools(accessToken), 200, label);
  assert.equal(payload.id, 1, label);
  assert.ok(payload.result?.tools?.some((tool) => tool.name === "search_events"), label);
}

async function beginConsent(clientId) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
    resource,
    scope,
  });
  const response = await fetchWorker(`/oauth/authorize?${query}`);
  assert.equal(response.status, 200, "GET consent page");
  assert.equal(response.headers.get("Referrer-Policy"), "same-origin", "preserve the browser's form POST Origin without sending referrers cross-origin");
  assert.match(response.headers.get("Content-Type") ?? "", /text\/html/i);
  const html = await response.text();
  const input = html.match(/<input\b[^>]*\bname=["']handle["'][^>]*>/i)?.[0];
  const handle = input?.match(/\bvalue=["']([^"']+)["']/i)?.[1];
  assert.ok(handle, "consent page should include a handle");
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.length, "consent page should set a browser-binding cookie");
  const cookie = cookies.map((value) => value.split(";", 1)[0]).join("; ");
  return { verifier, state, handle, cookie };
}

function submitConsent(consent, { key = ownerKey, cookie = consent.cookie, requestOrigin = origin } = {}) {
  return fetchWorker("/oauth/authorize", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(requestOrigin ? { Origin: requestOrigin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams({ handle: consent.handle, ownerKey: key }).toString(),
  });
}

async function assertConsentDenied(clientId, options, label) {
  const consent = await beginConsent(clientId);
  const response = await submitConsent(consent, options);
  assert.ok([400, 401, 403].includes(response.status), `${label}: status ${response.status}`);
  assert.equal(response.headers.get("Location"), null, label);
  await response.body?.cancel();
}

function exchange(fields) {
  return fetchWorker("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

try {
  const unauthenticated = await listTools();
  assert.equal(unauthenticated.status, 401);
  const challenge = unauthenticated.headers.get("WWW-Authenticate") ?? "";
  assert.match(challenge, /^Bearer\b/i);
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
  assert.equal(challenge.match(/\bresource_metadata="([^"]+)"/)?.[1], metadataUrl);
  await unauthenticated.body?.cancel();

  for (const endpoint of [metadataUrl, `${origin}/.well-known/oauth-protected-resource`]) {
    const metadata = await expectJson(await fetchWorker(endpoint), 200, `protected resource metadata: ${endpoint}`);
    assert.equal(metadata.resource, resource);
    assert.deepEqual(metadata.authorization_servers, [origin]);
    assert.ok(metadata.scopes_supported.includes(scope));
    assert.ok(metadata.bearer_methods_supported.includes("header"));
  }
  const server = await expectJson(await fetchWorker("/.well-known/oauth-authorization-server"), 200, "authorization server metadata");
  assert.equal(server.issuer, origin);
  assert.equal(server.authorization_endpoint, `${origin}/oauth/authorize`);
  assert.equal(server.token_endpoint, `${origin}/oauth/token`);
  assert.equal(server.registration_endpoint, `${origin}/oauth/register`);
  assert.equal(server.authorization_response_iss_parameter_supported, true);
  assert.ok(server.code_challenge_methods_supported.includes("S256"));
  assert.ok(server.token_endpoint_auth_methods_supported.includes("none"));
  assert.ok(server.grant_types_supported.includes("refresh_token"));
  assert.ok(server.scopes_supported.includes(scope));

  for (const uri of [`${evilOrigin}/connector_platform_oauth_redirect`, "https://chatgpt.com.example/connector/oauth/test", "https://chatgpt.com/unrelated"]) {
    const response = await register(uri);
    assert.equal(response.status, 400, `reject unapproved callback ${uri}`);
    await response.body?.cancel();
  }
  for (const uri of ["https://chatgpt.com/connector/oauth/test", redirectUri]) {
    const registration = await expectJson(await register(uri), 201, `register approved callback ${uri}`);
    assert.ok(registration.client_id);
    assert.equal(registration.token_endpoint_auth_method, "none");
    assert.deepEqual(registration.redirect_uris, [uri]);
    assert.equal(registration.client_secret, undefined, "public clients must not get a secret");
    if (uri !== redirectUri) continue;

    const clientId = registration.client_id;
    await assertConsentDenied(clientId, { key: "not-the-owner-key" }, "reject incorrect owner key");
    await assertConsentDenied(clientId, { cookie: "" }, "reject missing browser cookie");
    const differentBrowser = await beginConsent(clientId);
    await assertConsentDenied(clientId, { cookie: differentBrowser.cookie }, "reject a different browser cookie");
    await assertConsentDenied(clientId, { requestOrigin: evilOrigin }, "reject foreign Origin");
    await assertConsentDenied(clientId, { requestOrigin: "" }, "reject missing Origin");

    const consent = await beginConsent(clientId);
    const authorized = await submitConsent(consent);
    assert.ok([302, 303].includes(authorized.status), `authorize with owner key: status ${authorized.status}`);
    const authorizationRedirect = new URL(authorized.headers.get("Location"));
    assert.equal(`${authorizationRedirect.origin}${authorizationRedirect.pathname}`, redirectUri);
    assert.equal(authorizationRedirect.searchParams.get("state"), consent.state);
    assert.equal(authorizationRedirect.searchParams.get("iss"), origin);
    assert.equal(authorizationRedirect.searchParams.get("error"), null);
    const code = authorizationRedirect.searchParams.get("code");
    assert.ok(code, "authorization redirect should include a code");
    await authorized.body?.cancel();

    const grant = {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: consent.verifier,
      resource,
    };
    const invalidVerifier = await expectJson(await exchange({ ...grant, code_verifier: randomBytes(32).toString("base64url") }), 400, "reject wrong PKCE verifier");
    assert.equal(invalidVerifier.error, "invalid_grant");
    const invalidAudience = await expectJson(await exchange({ ...grant, resource: `${evilOrigin}/mcp` }), 400, "reject wrong audience");
    assert.equal(invalidAudience.error, "invalid_target");
    const tokens = await expectJson(await exchange(grant), 200, "exchange code");
    assert.equal(tokens.token_type.toLowerCase(), "bearer");
    assert.equal(tokens.scope, scope);
    assert.ok(tokens.access_token && tokens.refresh_token, "issue both access and refresh tokens");
    await assertCanListTools(tokens.access_token, "OAuth access token can list MCP tools");

    const refreshGrant = {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token,
      resource,
    };
    const refreshed = await expectJson(await exchange(refreshGrant), 200, "refresh access token");
    assert.ok(refreshed.access_token);
    assert.notEqual(refreshed.access_token, tokens.access_token);
    await assertCanListTools(refreshed.access_token, "refreshed access token can list MCP tools");
  }

  await assertCanListTools(ownerKey, "legacy fixed bearer can list MCP tools");
  console.log("Worker OAuth discovery, registration, consent, PKCE, audience, tool access, refresh, and legacy bearer passed");
} finally {
  await worker.dispose();
}
