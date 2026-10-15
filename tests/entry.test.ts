import { describe, it, expect, vi } from "vitest";
import lunaroute from "../src/index.js";

type Hook = { name: string; cb: (event: unknown) => void; opts: unknown };
type EventLike = { type: string; data?: Record<string, unknown> };

function makeEventStream() {
  const queue: EventLike[] = [];
  let pending: ((result: IteratorResult<EventLike>) => void) | undefined;
  let aborted = false;
  const deliver = (event: EventLike) => {
    if (pending) {
      const resolve = pending;
      pending = undefined;
      resolve({ done: false, value: event });
    } else queue.push(event);
  };
  return {
    push: deliver,
    abort() {
      aborted = true;
      if (pending) {
        const resolve = pending;
        pending = undefined;
        resolve({ done: true, value: undefined });
      }
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (aborted) return Promise.resolve({ done: true as const, value: undefined });
            if (queue.length) return Promise.resolve({ done: false as const, value: queue.shift() as EventLike });
            return new Promise<IteratorResult<EventLike>>((resolve) => {
              pending = resolve;
            });
          },
          return: () => Promise.resolve({ done: true as const, value: undefined }),
        };
      },
    },
  };
}

function makeCtx(auth?: { key: string }) {
  const providerAdded: { info: Record<string, unknown>; models: unknown[] }[] = [];
  const methods: Record<string, unknown>[] = [];
  const hooks: Hook[] = [];
  const mcpSet: unknown[] = [];
  const toolAdded: unknown[] = [];
  const modelCallbacks: ((editor: unknown) => void)[] = [];
  const reloads = { provider: vi.fn(async () => {}), mcp: vi.fn(async () => {}), tool: vi.fn(async () => {}), model: vi.fn(async () => {}) };
  const events = makeEventStream();

  const ctx = {
    provider: {
      transform: async (cb: (editor: unknown) => void) => cb({ get: () => undefined, add: (input: never) => void providerAdded.push(input) }),
      reload: reloads.provider,
    },
    integration: {
      transform: async (cb: (editor: unknown) => void) =>
        cb({
          get: () => undefined,
          update: (_id: string, update: (ref: { id: string; name?: string }) => void) => update({ id: "lunaroute", name: "LunaRoute" }),
          method: { update: (input: never) => void methods.push(input) },
        }),
      connection: {
        active: async () => (auth ? { id: "cred_test" } : undefined),
        resolve: async () => (auth ? { type: "key", key: auth.key } : undefined),
      },
    },
    session: {
      hook: async (name: string, cb: (event: unknown) => void, opts: unknown) => {
        hooks.push({ name, cb, opts });
        return {};
      },
    },
    mcp: {
      transform: async (cb: (editor: unknown) => void) =>
        cb({
          list: () => [],
          get: () => undefined,
          set: (_name: string, config: unknown) => void mcpSet.push(config),
        }),
      reload: reloads.mcp,
    },
    tool: {
      transform: async (cb: (editor: unknown) => void) => cb({ add: (input: never) => void toolAdded.push(input) }),
      reload: reloads.tool,
    },
    model: {
      transform: async (cb: (editor: unknown) => void) => {
        modelCallbacks.push(cb);
        return {};
      },
      reload: reloads.model,
    },
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal }) => {
        signal?.addEventListener("abort", () => events.abort());
        return events.stream;
      },
    },
  };
  return { ctx, providerAdded, methods, hooks, mcpSet, toolAdded, modelCallbacks, reloads, events };
}

describe("lunaroute v2 entry", () => {
  it("is a v2 plugin definition with the stable integration/provider id", () => {
    expect(lunaroute.id).toBe("lunaroute");
    expect(typeof lunaroute.setup).toBe("function");
  });

  it("registers provider, integration methods, attribution hook, MCP, and tools; returns cleanup", async () => {
    const { ctx, providerAdded, methods, hooks, mcpSet, toolAdded } = makeCtx();
    const cleanup = await lunaroute.setup(ctx as never);

    // provider: stub only, zero models while logged out
    expect(providerAdded).toHaveLength(1);
    expect(providerAdded[0].info).toMatchObject({
      id: "lunaroute",
      integrationID: "lunaroute",
      name: "LunaRoute",
    });
    expect(providerAdded[0].models).toEqual([]);

    // integration: key + browser + remote
    expect(methods.map((m) => (m.method as { type: string }).type)).toEqual(["oauth", "oauth", "key"]);

    // attribution headers on model requests, scoped to our provider
    expect(hooks).toHaveLength(1);
    expect(hooks[0].name).toBe("model.request");
    expect(hooks[0].opts).toEqual({ providerID: "lunaroute" });
    const event = { headers: {} as Record<string, string> };
    hooks[0].cb(event);
    expect(event.headers["lunaroute-agent"]).toBe("opencode");
    expect(event.headers["lunaroute-session-id"]).toBeTruthy();

    // logged out: no MCP entry, no tools, default model untouched
    expect(mcpSet).toHaveLength(0);
    expect(toolAdded).toHaveLength(0);

    expect(typeof cleanup).toBe("function");
    cleanup?.();
  });

  it("registers first-class tools with a declared output schema (kata fhk4)", async () => {
    const tools = ["generate_image", "web_search", "convert_document"];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      const jsonResponse = (payload: unknown) =>
        ({ ok: true, status: 200, text: async () => JSON.stringify(payload) }) as unknown as Response;
      if (url.includes("/models")) return jsonResponse({ data: [] });
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (body.method === "tools/list") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: tools.map((name) => ({ name })) } });
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
    });
    try {
      const { ctx, toolAdded } = makeCtx({ key: "lr_test_0000000000000000" });
      await lunaroute.setup(ctx as never);
      expect(toolAdded.length).toBeGreaterThan(0);
      for (const tool of toolAdded as { input?: unknown; output?: unknown }[]) {
        expect(tool.input).toBeDefined();
        expect(tool.output).toBeDefined();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refreshes provider, MCP, tools, and models on credential events for our integration", async () => {
    const { ctx, reloads, events } = makeCtx();
    await lunaroute.setup(ctx as never);

    events.push({ type: "credential.updated", data: { integrationID: "other" } });
    events.push({ type: "credential.switched", data: { integrationID: "lunaroute", credentialID: "c1" } });

    await vi.waitFor(() => {
      expect(reloads.provider).toHaveBeenCalledTimes(1);
    });
    expect(reloads.mcp).toHaveBeenCalledTimes(1);
    expect(reloads.tool).toHaveBeenCalledTimes(1);
    expect(reloads.model).toHaveBeenCalledTimes(1);
  });
});
