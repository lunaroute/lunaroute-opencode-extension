import { describe, it, expect, vi } from "vitest";
import type { ToolContext, ToolResult } from "@opencode-ai/plugin";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import {
  buildWebToolMap,
  createLunarouteMcpClient,
  formatWebSearchForModel,
  matchesAnyPattern,
  parseSseData,
  parseWebSearchPayload,
  pickServerTool,
  WEB_SEARCH_DESCRIPTION,
  type FetchLike,
  type WebToolMapDeps,
} from "../src/web-tools.js";

// ============================================================================
// Fake hosted MCP server (stateless Streamable HTTP, JSON responses)
// ============================================================================

type JsonRpcBody = { jsonrpc: string; id: number; method: string; params?: unknown };
type RecordedCall = { url: string; headers: Record<string, string>; signal?: AbortSignal; body: JsonRpcBody };

const jsonResponse = (payload: unknown, headers?: { get(name: string): string | null }) =>
  ({ ok: true, headers, text: async () => JSON.stringify(payload) }) as unknown as Response;
const statusResponse = (status: number) => ({ ok: false, status, text: async () => "" }) as unknown as Response;

interface FakeMcpRoutes {
  tools?: string[];
  callResult?: (args: Record<string, unknown>) => { content: { type: string; text: string }[]; isError?: boolean };
  callNoResult?: boolean;
  initializeOk?: boolean;
  failToolsList?: boolean;
  listError?: { message: string };
  /** Stateful-gateway mode: initialize responds with Mcp-Session-Id. */
  sessionHeader?: string;
}

function fakeMcp(routes: FakeMcpRoutes = {}) {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as JsonRpcBody;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers, signal: init?.signal ?? undefined, body });
    if (body.method === "initialize") {
      if (routes.initializeOk === false) return statusResponse(500);
      const headers = routes.sessionHeader
        ? { get: (name: string): string | null => (name.toLowerCase() === "mcp-session-id" ? routes.sessionHeader! : null) }
        : undefined;
      return jsonResponse(
        { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } },
        headers,
      );
    }
    if (body.method === "tools/list") {
      if (routes.failToolsList) return statusResponse(503);
      if (routes.listError) return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: routes.listError.message } });
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: (routes.tools ?? []).map((name) => ({ name })) } });
    }
    if (body.method === "tools/call") {
      const args = (body.params as { arguments: Record<string, unknown> }).arguments;
      if (routes.callNoResult) return jsonResponse({ jsonrpc: "2.0", id: body.id });
      const result = routes.callResult?.(args) ?? { content: [] };
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result });
    }
    return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
  };
  return { fetchImpl, calls };
}

// ============================================================================
// Gate deps + execute helpers
// ============================================================================

const valid = (key: string) => ({ state: "valid", key }) as const;

const makeDeps = (fetchImpl: FetchLike, over: Partial<WebToolMapDeps> = {}): WebToolMapDeps => ({
  env: {},
  mcpUrl: "http://mcp",
  sessionId: "sess-1",
  fetchImpl,
  resolveKey: async () => valid("lr_good"),
  readSettingsNow: () => ({ ...DEFAULT_SETTINGS }),
  ...over,
});

const ctx = (signal?: AbortSignal): ToolContext =>
  ({ abort: signal ?? new AbortController().signal }) as unknown as ToolContext;

/** ToolResult is string | { output, … } — narrow for assertions. */
const outputOf = (r: ToolResult): string => (typeof r === "string" ? r : r.output);
const metadataOf = (r: ToolResult): { [key: string]: unknown } | undefined => (typeof r === "string" ? undefined : r.metadata);

const callBodies = (calls: RecordedCall[], method: string) => calls.filter((c) => c.body.method === method);

// ============================================================================
// SSE / JSON-RPC decoding
// ============================================================================

describe("parseSseData", () => {
  it("parses data: lines in order, skips [DONE] and malformed frames, ignores non-data lines", () => {
    const body = ['event: message', 'data: {"a":1}', '', 'data: [DONE]', 'data: not-json', 'data: {"b":2}', ''].join("\n");
    expect(parseSseData(body)).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("createLunarouteMcpClient", () => {
  it("initialize handshake once, then tools/list with auth + content headers on every POST", async () => {
    const { fetchImpl, calls } = fakeMcp({ tools: ["web_search"] });
    const client = createLunarouteMcpClient({
      url: "http://mcp",
      headers: { "LUNAROUTE-API-KEY": "lr_k", "lunaroute-agent": "opencode" },
      fetchImpl,
    });
    const tools = await client.listTools();
    expect(tools).toEqual(["web_search"]);
    expect(calls.map((c) => c.body.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect((calls[0].body.params as { clientInfo: { name: string } }).clientInfo.name).toBe("lunaroute-opencode-extension");
    for (const c of calls) {
      expect(c.url).toBe("http://mcp");
      expect(c.headers["Content-Type"]).toBe("application/json");
      expect(c.headers.Accept).toBe("application/json, text/event-stream");
      expect(c.headers["LUNAROUTE-API-KEY"]).toBe("lr_k");
      expect(c.headers["lunaroute-agent"]).toBe("opencode");
      expect(c.headers["Mcp-Session-Id"]).toBeUndefined(); // stateless server: header never sent
    }
    expect("id" in calls[1].body).toBe(false); // notifications/initialized is a true notification
  });

  it("captures Mcp-Session-Id from initialize and echoes it on every later request of the client", async () => {
    const { fetchImpl, calls } = fakeMcp({ tools: ["web_search"], sessionHeader: "sess-gw" });
    const client = createLunarouteMcpClient({ url: "http://mcp", headers: {}, fetchImpl });
    await client.listTools();
    expect(calls[0].headers["Mcp-Session-Id"]).toBeUndefined(); // initialize itself carries none
    expect(calls[1].headers["Mcp-Session-Id"]).toBe("sess-gw");
    expect(calls[2].headers["Mcp-Session-Id"]).toBe("sess-gw");
    await client.callTool("web_search", {});
    expect(callBodies(calls, "tools/call")[0].headers["Mcp-Session-Id"]).toBe("sess-gw");
  });

  it("initialize rejection is tolerated (stateless server)", async () => {
    const { fetchImpl } = fakeMcp({ tools: ["web_search"], initializeOk: false });
    const client = createLunarouteMcpClient({ url: "http://mcp", headers: {}, fetchImpl });
    await expect(client.listTools()).resolves.toEqual(["web_search"]);
  });

  it("HTTP failure throws with method + status", async () => {
    const { fetchImpl } = fakeMcp({ failToolsList: true });
    const client = createLunarouteMcpClient({ url: "http://mcp", headers: {}, fetchImpl });
    await expect(client.listTools()).rejects.toThrow("MCP tools/list failed: HTTP 503");
  });

  it("JSON-RPC error throws with the server message", async () => {
    const { fetchImpl } = fakeMcp({ listError: { message: "boom" } });
    const client = createLunarouteMcpClient({ url: "http://mcp", headers: {}, fetchImpl });
    await expect(client.listTools()).rejects.toThrow("boom");
  });

  it("SSE body: id-matched frames, last one wins", async () => {
    const sseFetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as JsonRpcBody;
      if (body.method !== "tools/list") return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
      const sse = [
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 4242, result: { tools: [{ name: "wrong-id" }] } })}`,
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "first" }] } })}`,
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "last" }] } })}`,
        "data: [DONE]",
      ].join("\n");
      return ({ ok: true, text: async () => sse }) as unknown as Response;
    };
    const client = createLunarouteMcpClient({ url: "http://mcp", headers: {}, fetchImpl: sseFetch });
    await expect(client.listTools()).resolves.toEqual(["last"]);
  });

  it("callTool: name + arguments on the wire; isError → throws with content text; no result → throws", async () => {
    const { fetchImpl, calls } = fakeMcp({ tools: ["web_search"], callResult: () => ({ content: [{ type: "text", text: "ok" }] }) });
    const client = createLunarouteMcpClient({ url: "http://mcp", headers: {}, fetchImpl });
    await client.callTool("web_search", { query: "q" });
    const call = callBodies(calls, "tools/call")[0];
    expect(call.body.params).toEqual({ name: "web_search", arguments: { query: "q" } });

    const err = fakeMcp({ callResult: () => ({ content: [{ type: "text", text: "provider unavailable" }], isError: true }) });
    await expect(
      createLunarouteMcpClient({ url: "http://mcp", headers: {}, fetchImpl: err.fetchImpl }).callTool("web_search", {}),
    ).rejects.toThrow("provider unavailable");

    const none = fakeMcp({ callNoResult: true });
    await expect(
      createLunarouteMcpClient({ url: "http://mcp", headers: {}, fetchImpl: none.fetchImpl }).callTool("web_search", {}),
    ).rejects.toThrow("returned no result");
  });
});

// ============================================================================
// Server-tool name resolution
// ============================================================================

describe("pickServerTool", () => {
  const patterns = [/^web_?search$/i, /^search_?web$/i, /_web_?search$/i];
  it("pattern-matches tools/list (incl. adapter-prefixed names)", () => {
    expect(pickServerTool(["generate_image", "web_search"], patterns, undefined)).toBe("web_search");
    expect(pickServerTool(["lunaroute_web_search"], patterns, undefined)).toBe("lunaroute_web_search");
    expect(pickServerTool(["generate_image"], patterns, undefined)).toBeUndefined();
  });
  it("env override wins when present in tools/list; absent override → no fallback", () => {
    expect(pickServerTool(["my_search"], patterns, "my_search")).toBe("my_search");
    expect(pickServerTool(["web_search"], patterns, "my_search")).toBeUndefined();
  });
  it("matchesAnyPattern covers fetch conventions", () => {
    expect(matchesAnyPattern("fetch_content", [/^fetch_?content$/i])).toBe(true);
    expect(matchesAnyPattern("url_context", [/^url_?context$/i])).toBe(true);
  });
});

// ============================================================================
// Payload shaping
// ============================================================================

describe("parseWebSearchPayload + formatWebSearchForModel", () => {
  it("parses the normalized payload and formats numbered results", () => {
    const payload = parseWebSearchPayload(
      JSON.stringify({ query: "q", provider: "brave", results: [{ title: "T", url: "https://u", snippet: "S", published_date: "2026-01-01" }] }),
    );
    const out = formatWebSearchForModel(payload);
    expect(out).toContain('Web search for "q" via brave — 1 result(s):');
    expect(out).toContain("1. T");
    expect(out).toContain("https://u");
    expect(out).toContain("S");
    expect(out).toContain("published: 2026-01-01");
  });
  it("non-JSON server text is passed through as rawText", () => {
    const payload = parseWebSearchPayload("plain text");
    expect(payload.rawText).toBe("plain text");
    expect(formatWebSearchForModel(payload)).toBe("plain text");
  });
  it("empty results message", () => {
    expect(formatWebSearchForModel({ query: "q", provider: "brave", results: [] })).toBe('No results for "q" (provider: brave).');
  });
  it("hostile payload shapes never throw: non-object results dropped, non-string fields normalized", () => {
    const payload = parseWebSearchPayload(
      JSON.stringify({ query: "q", provider: "brave", results: [null, 5, { title: 42, url: "https://u", snippet: {}, published_date: "2026-01-01" }] }),
    );
    expect(payload.results).toHaveLength(1);
    const out = formatWebSearchForModel(payload);
    expect(out).toContain("(untitled)");
    expect(out).toContain("https://u");
    expect(out).toContain("published: 2026-01-01");
  });
  it("results array of nulls → empty-results message (no throw)", () => {
    const payload = parseWebSearchPayload('{"results":[null]}');
    expect(payload.results).toEqual([]);
    expect(formatWebSearchForModel(payload)).toBe("No results.");
  });
});

// ============================================================================
// Registration gate
// ============================================================================

describe("buildWebToolMap", () => {
  it("settings off (env) → no key resolution, no probe", async () => {
    const { fetchImpl, calls } = fakeMcp({ tools: ["web_search"] });
    const resolveKey = vi.fn(async () => valid("lr_good"));
    const map = await buildWebToolMap(makeDeps(fetchImpl, { env: { LUNAROUTE_WEB_TOOLS: "off" }, resolveKey }));
    expect(map).toEqual({});
    expect(resolveKey).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("settings off (file) → no tools", async () => {
    const { fetchImpl } = fakeMcp({ tools: ["web_search"] });
    const map = await buildWebToolMap(
      makeDeps(fetchImpl, { readSettingsNow: () => ({ ...DEFAULT_SETTINGS, webTools: "off" }) }),
    );
    expect(map).toEqual({});
  });

  it("logged out → no tools, no probe", async () => {
    const { fetchImpl, calls } = fakeMcp({ tools: ["web_search"] });
    const map = await buildWebToolMap(makeDeps(fetchImpl, { resolveKey: async () => ({ state: "logged-out" }) }));
    expect(map).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("indeterminate auth → no tools, no probe (fail-safe)", async () => {
    const { fetchImpl, calls } = fakeMcp({ tools: ["web_search"] });
    const map = await buildWebToolMap(
      makeDeps(fetchImpl, { resolveKey: async () => ({ state: "indeterminate", reason: "auth store missing" }) }),
    );
    expect(map).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("probe failure → no tools + one warn; retried on the next invocation (nothing cached)", async () => {
    const { fetchImpl } = fakeMcp({ failToolsList: true });
    const logs: { level: string; message: string }[] = [];
    const deps = makeDeps(fetchImpl, { log: (level, message) => logs.push({ level, message }) });
    expect(await buildWebToolMap(deps)).toEqual({});
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe("warn");
    expect(logs[0].message).toContain("web tools not registered");
  });

  it("server without a search tool → no tools registered", async () => {
    const { fetchImpl } = fakeMcp({ tools: ["generate_image"] });
    expect(await buildWebToolMap(makeDeps(fetchImpl))).toEqual({});
  });

  it("server offers web_search → registered with the pi-parity description", async () => {
    const { fetchImpl } = fakeMcp({ tools: ["generate_image", "web_search"] });
    const map = await buildWebToolMap(makeDeps(fetchImpl));
    expect(Object.keys(map)).toEqual(["web_search"]);
    expect(map.web_search.description).toBe(WEB_SEARCH_DESCRIPTION);
    expect(map.web_search.description).toContain("Issue multiple web_search calls in one message");
  });

  it("a fetch-pattern server tool lights web_fetch up too (dormant until the server ships it)", async () => {
    const { fetchImpl } = fakeMcp({ tools: ["web_search", "fetch_content"] });
    const map = await buildWebToolMap(makeDeps(fetchImpl));
    expect(Object.keys(map).sort()).toEqual(["web_fetch", "web_search"]);
    expect(map.web_fetch.description).toBe("Fetch a web page as text via LunaRoute.");
  });

  it("env override picks the named server tool; an absent override registers nothing", async () => {
    const a = fakeMcp({ tools: ["my_search"] });
    const mapA = await buildWebToolMap(makeDeps(a.fetchImpl, { env: { LUNAROUTE_MCP_WEB_SEARCH_TOOL: "my_search" } }));
    expect(mapA.web_search).toBeDefined();

    const b = fakeMcp({ tools: ["web_search"] });
    const mapB = await buildWebToolMap(makeDeps(b.fetchImpl, { env: { LUNAROUTE_MCP_WEB_SEARCH_TOOL: "my_search" } }));
    expect(mapB).toEqual({}); // override not in tools/list → no pattern fallback
  });
});

// ============================================================================
// web_search execute
// ============================================================================

describe("web_search execute", () => {
  const searchPayload = (query: string) =>
    JSON.stringify({
      query,
      provider: "brave",
      results: [{ title: `About ${query}`, url: "https://u", snippet: "S", published_date: "2026-01-01" }],
    });

  const build = async (routes: FakeMcpRoutes, over: Partial<WebToolMapDeps> = {}) => {
    const server = fakeMcp(routes);
    const deps = makeDeps(server.fetchImpl, over);
    const map = await buildWebToolMap(deps);
    return { map, server, deps };
  };

  it("hits the hosted MCP with the lr_ key + attribution headers; query/count on the wire", async () => {
    const { map, server } = await build({ tools: ["web_search"], callResult: () => ({ content: [{ type: "text", text: searchPayload("q") }] }) });
    const result = await map.web_search.execute({ query: "q", count: 5 }, ctx());
    const calls = callBodies(server.calls, "tools/call");
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["LUNAROUTE-API-KEY"]).toBe("lr_good");
    expect(calls[0].headers["lunaroute-agent"]).toBe("opencode");
    expect(calls[0].headers["x-lunaroute-session"]).toBe("sess-1");
    expect(calls[0].headers["lunaroute-session-id"]).toBe("sess-1");
    expect(calls[0].body.params).toEqual({ name: "web_search", arguments: { query: "q", count: 5 } });
    expect(outputOf(result)).toContain('Web search for "q" via brave — 1 result(s):');
    expect(metadataOf(result)).toMatchObject({
      provider: "brave",
      resultCount: 1,
    });
  });

  it("provider: per-call arg wins; settings default applies when the arg is absent; absent everywhere → key omitted", async () => {
    let settings = { ...DEFAULT_SETTINGS };
    const { map, server } = await build(
      { tools: ["web_search"], callResult: () => ({ content: [{ type: "text", text: searchPayload("q") }] }) },
      { readSettingsNow: () => settings },
    );
    await map.web_search.execute({ query: "a", provider: "kagi" }, ctx());
    await map.web_search.execute({ query: "b" }, ctx()); // settings: server → omitted
    settings = { ...DEFAULT_SETTINGS, searchProvider: "exa" };
    await map.web_search.execute({ query: "c" }, ctx()); // settings changed → next call follows
    const args = callBodies(server.calls, "tools/call").map((c) => (c.body.params as { arguments: Record<string, unknown> }).arguments);
    expect(args[0].provider).toBe("kagi");
    expect(args[1].provider).toBeUndefined();
    expect(args[2].provider).toBe("exa");
  });

  it("malformed server text → rawText passthrough; isError → execute rejects", async () => {
    const bad = await build({ tools: ["web_search"], callResult: () => ({ content: [{ type: "text", text: "not json" }] }) });
    const out = await bad.map.web_search.execute({ query: "q" }, ctx());
    expect(outputOf(out)).toBe("not json");

    const err = await build({ tools: ["web_search"], callResult: () => ({ content: [{ type: "text", text: "rate limited" }], isError: true }) });
    await expect(err.map.web_search.execute({ query: "q" }, ctx())).rejects.toThrow("rate limited");
  });

  it("mid-session logout → clean /connect error (tool stays registered; key re-read per execute)", async () => {
    let resolution: { state: "valid"; key: string } | { state: "logged-out" } = valid("lr_good");
    const { map } = await build(
      { tools: ["web_search"], callResult: () => ({ content: [{ type: "text", text: searchPayload("q") }] }) },
      { resolveKey: async () => resolution },
    );
    await map.web_search.execute({ query: "first" }, ctx()); // still valid
    resolution = { state: "logged-out" };
    await expect(map.web_search.execute({ query: "second" }, ctx())).rejects.toThrow(/\/connect/);
  });

  it("key rotation → the next call carries the fresh key", async () => {
    // resolveKey sequence: gate probe (lr_a), execute 1 (lr_a), execute 2 (rotated lr_b).
    const keys = ["lr_a", "lr_a", "lr_b"];
    let i = 0;
    const { map, server } = await build(
      { tools: ["web_search"], callResult: () => ({ content: [{ type: "text", text: searchPayload("q") }] }) },
      { resolveKey: async () => valid(keys[Math.min(i++, keys.length - 1)]) },
    );
    await map.web_search.execute({ query: "1" }, ctx());
    await map.web_search.execute({ query: "2" }, ctx());
    const calls = callBodies(server.calls, "tools/call");
    expect(calls[0].headers["LUNAROUTE-API-KEY"]).toBe("lr_a");
    expect(calls[1].headers["LUNAROUTE-API-KEY"]).toBe("lr_b");
  });

  it("concurrent executes are independent (fresh client per call, keyed results)", async () => {
    const { map } = await build({
      tools: ["web_search"],
      callResult: (args) => ({ content: [{ type: "text", text: searchPayload(String(args.query)) }] }),
    });
    const [a, b] = await Promise.all([map.web_search.execute({ query: "alpha" }, ctx()), map.web_search.execute({ query: "beta" }, ctx())]);
    expect(outputOf(a)).toContain('Web search for "alpha"');
    expect(outputOf(b)).toContain('Web search for "beta"');
  });

  it("the caller's abort signal is threaded to the wire", async () => {
    const { map, server } = await build({ tools: ["web_search"], callResult: () => ({ content: [{ type: "text", text: searchPayload("q") }] }) });
    const controller = new AbortController();
    await map.web_search.execute({ query: "q" }, ctx(controller.signal));
    expect(callBodies(server.calls, "tools/call")[0].signal).toBe(controller.signal);
  });
});

// ============================================================================
// web_fetch execute
// ============================================================================

describe("web_fetch execute", () => {
  it("passes {url} and returns the server text verbatim", async () => {
    const server = fakeMcp({
      tools: ["fetch_content"],
      callResult: (args) => ({ content: [{ type: "text", text: `content of ${args.url}` }] }),
    });
    const map = await buildWebToolMap(makeDeps(server.fetchImpl));
    const result = await map.web_fetch.execute({ url: "https://x" }, ctx());
    expect(callBodies(server.calls, "tools/call")[0].body.params).toEqual({ name: "fetch_content", arguments: { url: "https://x" } });
    expect(outputOf(result)).toBe("content of https://x");
  });
});
