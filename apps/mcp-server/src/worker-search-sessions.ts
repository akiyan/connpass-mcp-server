import type {
  DurableObjectNamespace,
  DurableObjectState,
  Request as WorkerRequest,
  Response as WorkerResponse,
} from "@cloudflare/workers-types";
import type { FormattedEventsResponse } from "./tools/utils/formatting.js";
import {
  SEARCH_SESSION_TTL_MS,
  type SearchSessionStorage,
} from "./tools/utils/searchSessionStore.js";

interface Entry {
  expiresAt: number;
  result: FormattedEventsResponse;
}

// One object per search ID: reads work immediately from any Worker isolate,
// and the alarm removes the result even when it is never browsed.
export class SearchSessionObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: WorkerRequest): Promise<Response> {
    if (request.method === "PUT") {
      const result = await request.json<FormattedEventsResponse>();
      const expiresAt = Date.now() + SEARCH_SESSION_TTL_MS;
      await this.state.storage.setAlarm(expiresAt);
      await this.state.storage.put<Entry>("result", { expiresAt, result });
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET") {
      const entry = await this.state.storage.get<Entry>("result");
      if (!entry || entry.expiresAt <= Date.now()) {
        return new Response(null, { status: 404 });
      }
      return Response.json(entry.result);
    }
    return new Response(null, { status: 405 });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

export class WorkerSearchSessionStore implements SearchSessionStorage {
  constructor(private readonly namespace: DurableObjectNamespace) {}

  private request(
    id: string,
    init?: { method: string; body: string },
  ): Promise<WorkerResponse> {
    const stub = this.namespace.get(this.namespace.idFromName(id));
    return stub.fetch("https://search-session.internal/", init);
  }

  async save(result: FormattedEventsResponse): Promise<string> {
    const id = crypto.randomUUID();
    const response = await this.request(id, {
      method: "PUT",
      body: JSON.stringify(result),
    });
    if (!response.ok) throw new Error("Could not save search results");
    return id;
  }

  async get(id: string): Promise<FormattedEventsResponse | undefined> {
    const response = await this.request(id);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error("Could not load search results");
    return response.json<FormattedEventsResponse>();
  }
}
