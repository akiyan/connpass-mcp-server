import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

// Exercise the same bundle that Wrangler uploads, without real API credentials.
const dir = fileURLToPath(new URL("../.wrangler/worker-check/", import.meta.url));
let calls = 0;
const worker = new Miniflare({
  scriptPath: `${dir}worker.js`,
  modulesRoot: dir,
  modules: true,
  modulesRules: [{ type: "Text", include: ["**/*.html"] }],
  compatibilityDate: "2026-05-01",
  compatibilityFlags: ["nodejs_compat"],
  bindings: { CONNPASS_API_KEY: "dummy", MCP_API_KEY: "local-test-token" },
  durableObjects: {
    SEARCH_SESSIONS: { className: "SearchSessionObject", useSQLite: true },
  },
  outboundService(request) {
    const url = new URL(request.url);
    assert.equal(url.origin, "https://connpass.com");
    assert.equal(url.pathname, "/api/v2/events/");
    assert.equal(url.searchParams.get("keyword_or"), "Workers,MCP");
    assert.deepEqual(url.searchParams.getAll("ymd"), ["20261125", "20261126"]);
    assert.equal(request.headers.get("X-API-Key"), "dummy");
    calls++;
    return Response.json({ results_available: 0, results_returned: 0, results_start: 1, events: [] });
  },
});

async function call(name, args) {
  const response = await worker.dispatchFetch("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer local-test-token",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.result, JSON.stringify(payload));
  return payload.result;
}

try {
  const search = await call("search_events", { anyQuery: "Workers,MCP", on: ["2026-11-25", "2026-11-26"] });
  assert.notEqual(search.isError, true, JSON.stringify(search));
  const { searchSessionId } = search.structuredContent;
  assert.match(searchSessionId, /^[a-f0-9-]{36}$/);

  const browse = await call("browse_events", { searchSessionId });
  assert.notEqual(browse.isError, true, JSON.stringify(browse));
  assert.equal(browse.structuredContent.searchSessionId, searchSessionId);
  assert.deepEqual(browse.structuredContent.data.events, []);

  const unknown = await call("browse_events", { searchSessionId: "ec486aa4-7786-4190-b249-d90b9de41789" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /not found or expired/);
  assert.equal(calls, 1, "browse_events must not call the upstream API");
  console.log("Worker Connpass API and durable search sessions passed");
} finally {
  await worker.dispose();
}
