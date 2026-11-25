import assert from "node:assert/strict";

// Run against Wrangler with MCP_API_KEY=local-test-token and CONNPASS_API_KEY=dummy.
// If testing an explicit Worker origin allowlist, set MCP_ALLOWED_ORIGINS here too.
const token = "local-test-token";
const resourceUri = "ui://connpass/app.html";
const requestedProtocolVersion = "2025-06-18";
const bearer = { Authorization: `Bearer ${token}` };
const apiKey = { "X-API-Key": token };

async function smoke(baseUrl) {
  let nextId = 1;
  let protocolVersion;

  async function request(path, options = {}) {
    const url = new URL(path, baseUrl);
    try {
      return await fetch(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new Error(`${options.method ?? "GET"} ${url}: ${error.message}`, {
        cause: error,
      });
    }
  }

  async function expectStatus(response, expected, label) {
    if (response.status !== expected) {
      const body = (await response.text()).slice(0, 500);
      assert.equal(response.status, expected, `${label}: HTTP ${response.status}: ${body}`);
    }
  }

  function expectPrivateStatelessResponse(response, label) {
    assert.match(
      response.headers.get("cache-control") ?? "",
      /(?:^|,)\s*no-store\s*(?:,|$)/i,
      `${label}: expected Cache-Control: no-store`,
    );
    assert.equal(response.headers.get("mcp-session-id"), null, `${label}: unexpected MCP session ID`);
  }

  function post(message, headers = {}) {
    return request("/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...(protocolVersion ? { "Mcp-Protocol-Version": protocolVersion } : {}),
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
    });
  }

  async function call(method, params, headers = bearer) {
    const id = nextId++;
    const response = await post({ id, method, params }, headers);
    await expectStatus(response, 200, method);
    expectPrivateStatelessResponse(response, method);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i, method);
    const body = await response.json();
    assert.equal(body.jsonrpc, "2.0", method);
    assert.equal(body.id, id, method);
    assert.equal(body.error, undefined, `${method}: ${JSON.stringify(body.error)}`);
    assert.ok(body.result && typeof body.result === "object", `${method}: missing result`);
    return body.result;
  }

  const health = await request("/health");
  await expectStatus(health, 200, "unauthenticated GET /health");
  await health.text();

  const initialize = {
    protocolVersion: requestedProtocolVersion,
    capabilities: {},
    clientInfo: { name: "connpass-worker-smoke", version: "0.0.0" },
  };
  for (const [label, headers] of [
    ["no credentials", {}],
    ["wrong Bearer token", { Authorization: "Bearer wrong-token" }],
    ["wrong X-API-Key", { "X-API-Key": "wrong-token" }],
  ]) {
    const response = await post({ id: nextId++, method: "initialize", params: initialize }, headers);
    await expectStatus(response, 401, label);
    expectPrivateStatelessResponse(response, label);
    await response.text();
  }

  const initialized = await call("initialize", initialize);
  assert.equal(initialized.protocolVersion, requestedProtocolVersion);
  assert.equal(initialized.serverInfo?.name, "connpass-mcp-server");
  assert.ok(initialized.capabilities?.tools, "initialize: tools capability missing");
  assert.ok(initialized.capabilities?.resources, "initialize: resources capability missing");
  protocolVersion = initialized.protocolVersion;

  const notification = await post({ method: "notifications/initialized" }, bearer);
  await expectStatus(notification, 202, "notifications/initialized");
  expectPrivateStatelessResponse(notification, "notifications/initialized");
  assert.equal(await notification.text(), "", "notification response should be empty");

  // No session header is sent on any request, and the API key alternative works.
  const tools = await call("tools/list", {}, apiKey);
  assert.ok(tools.tools.some(({ name }) => name === "list_prefectures"), "prefectures tool missing");
  const result = await call("tools/call", { name: "list_prefectures", arguments: {} });
  assert.notEqual(result.isError, true, "list_prefectures should not need the Connpass API");
  assert.equal(result.structuredContent?.kind, "prefectures");
  assert.deepEqual(result.structuredContent.data.invalid, []);
  assert.ok(
    result.structuredContent.data.prefectures.some(({ code, name }) => code === "tokyo" && name === "東京都"),
    "list_prefectures did not return Tokyo",
  );

  const resources = await call("resources/list", {});
  assert.ok(resources.resources.some(({ uri }) => uri === resourceUri), "UI resource missing from list");
  const read = await call("resources/read", { uri: resourceUri });
  const html = read.contents.find(({ uri }) => uri === resourceUri);
  assert.ok(html, "resources/read did not return the UI resource");
  assert.match(html.mimeType, /^text\/html;\s*profile=mcp-app$/i);
  assert.match(html.text, /<!doctype html>/i);
  assert.match(html.text, /<title>Connpass Events<\/title>/);
  assert.match(html.text, /<script\b[^>]*>\s*\S/i, "UI JavaScript should be bundled inline");
  assert.doesNotMatch(html.text, /<script\b[^>]*\ssrc\s*=/i, "UI must not depend on a separate script");

  const badVersion = await post(
    { id: nextId++, method: "ping" },
    { ...bearer, "Mcp-Protocol-Version": "2099-01-01" },
  );
  await expectStatus(badVersion, 400, "unsupported MCP protocol version");
  expectPrivateStatelessResponse(badVersion, "unsupported MCP protocol version");
  assert.equal((await badVersion.json()).error?.code, -32000);

  const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  await call("ping", {}, { ...bearer, Origin: allowedOrigins[0] ?? baseUrl.origin });
  let blockedOrigin = "https://not-allowed.invalid";
  for (let n = 1; blockedOrigin === baseUrl.origin || allowedOrigins.includes(blockedOrigin); n++) {
    blockedOrigin = `https://not-allowed-${n}.invalid`;
  }
  const blocked = await post({ id: nextId++, method: "ping" }, { ...bearer, Origin: blockedOrigin });
  await expectStatus(blocked, 403, "authenticated request with unlisted Origin");
  await blocked.text();
}

try {
  const baseUrl = new URL(process.argv[2] ?? "http://127.0.0.1:8787");
  await smoke(baseUrl);
  console.log(`Worker MCP smoke test passed at ${baseUrl.origin}`);
} catch (error) {
  console.error("Worker MCP smoke test failed:", error);
  process.exitCode = 1;
}
