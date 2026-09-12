import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { buildAttributionHeaders } from "./lunaroute.js";
import type { AuthResolution } from "./mcp.js";
import { resolveSearchProvider, webToolsEnabled, type LunarouteSettings } from "./settings.js";

/**
 * First-class web tools (kata gygp, pi akyg parity): `web_search` (and a
 * dormant `web_fetch`) backed by a minimal direct MCP Streamable HTTP client
 * to the hosted LunaRoute server — lr_ key + attribution headers, no
 * adapter dependency, independent of the session's `mcp.lunaroute`
 * registration.
 *
 * Registration gate, per plugin invocation (= pi's per-session_start):
 * settings allow + valid key + the server's tools/list offers the tool. No
 * memoization, no failure caching — a failed probe is retried on the next
 * invocation (pi parity; the repo's catalog memo follows the same
 * never-cache-failures discipline).
 *
 * Dropped vs pi: detect-and-backfill. Pi pattern-matches other extensions'
 * tool names at session_start (getAllTools); OpenCode plugins cannot
 * enumerate tools at init, so first-class registration is unconditional
 * (builtin `websearch` coexists under a different name). If another plugin
 * registers `web_search`, host collision behavior is unverified.
 *
 * Transport (verified against pi's web-tools.ts, ported near-verbatim): the
 * hosted server is stateless Streamable HTTP over plain JSON — tools/call
 * works standalone. A one-time initialize handshake is still sent so
 * stateful gateways behind LUNAROUTE_MCP_URL behave; a returned
 * Mcp-Session-Id is captured and echoed for that client's lifetime (the
 * client is fresh per execute, so no cross-execute state).
 */

// ============================================================================
// Server-tool name patterns (pi parity)
// ============================================================================

const WEB_SEARCH_TOOL_PATTERNS = [/^web_?search$/i, /^search_?web$/i, /_web_?search$/i];
const WEB_FETCH_TOOL_PATTERNS = [
  /^web_?fetch$/i,
  /^fetch_?content$/i,
  /^url_?context$/i,
  /_web_?fetch$/i,
  /_fetch_?content$/i,
];

export function matchesAnyPattern(name: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(name));
}

/** Pick the server-side MCP tool backing a first-class web tool: an explicit
 * env override wins (exact name, must be in tools/list — no pattern
 * fallback), otherwise the first tools/list pattern match. */
export function pickServerTool(serverTools: string[], patterns: RegExp[], override: string | undefined): string | undefined {
  if (override) return serverTools.includes(override) ? override : undefined;
  return serverTools.find((n) => matchesAnyPattern(n, patterns));
}

export const LUNAROUTE_ENV_MCP_WEB_SEARCH_TOOL = "LUNAROUTE_MCP_WEB_SEARCH_TOOL";
export const LUNAROUTE_ENV_MCP_WEB_FETCH_TOOL = "LUNAROUTE_MCP_WEB_FETCH_TOOL";

// ============================================================================
// MCP client (minimal Streamable HTTP JSON-RPC)
// ============================================================================

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface McpToolCallResult {
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  isError?: boolean;
}

export interface LunarouteMcpClient {
  listTools(signal?: AbortSignal): Promise<string[]>;
  /** Full tools/list descriptors (name + inputSchema) — the image tools bake
   * the server's per-org model enum into their schema from these (kata 5715). */
  listToolDescriptors(signal?: AbortSignal): Promise<{ name: string; inputSchema?: unknown }[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult>;
}

/** Extract JSON payloads from an SSE body (data: lines), in order. */
export function parseSseData(body: string): unknown[] {
  const payloads: unknown[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(data));
    } catch {
      // Ignore malformed SSE frames.
    }
  }
  return payloads;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function decodeJsonRpcBody(body: string, expectedId: number): JsonRpcResponse {
  const contentTypeIsSse = body.includes("data:");
  if (contentTypeIsSse && !body.trimStart().startsWith("{")) {
    const frames = parseSseData(body).filter(
      (f): f is JsonRpcResponse =>
        typeof f === "object" && f !== null && (f as JsonRpcResponse).id === expectedId,
    );
    if (frames.length === 0) throw new Error("MCP: no response frame in SSE stream");
    return frames[frames.length - 1];
  }
  return JSON.parse(body) as JsonRpcResponse;
}

/** Minimal MCP Streamable HTTP client for the hosted LunaRoute server.
 * One POST per call; a lazy initialize handshake runs once and is optional
 * (the production server is stateless and accepts bare tools/call). */
export function createLunarouteMcpClient(opts: {
  url: string;
  headers: Record<string, string>;
  fetchImpl: FetchLike;
}): LunarouteMcpClient {
  let nextId = 1;
  let initialized = false;
  // Issued by stateful Streamable HTTP gateways on initialize; captured once
  // and echoed on every later request of THIS client. The client is fresh
  // per execute, so this is per-call state — never shared across executes.
  let serverSessionId: string | undefined;

  const wireHeaders = (): Record<string, string> => ({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...opts.headers,
    ...(serverSessionId ? { "Mcp-Session-Id": serverSessionId } : {}),
  });

  async function rpc(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = nextId++;
    const response = await opts.fetchImpl(opts.url, {
      method: "POST",
      headers: wireHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`MCP ${method} failed: HTTP ${response.status}`);
    }
    const issued = response.headers?.get?.("Mcp-Session-Id");
    if (typeof issued === "string" && issued && !serverSessionId) serverSessionId = issued;
    const decoded = decodeJsonRpcBody(await response.text(), id);
    if (decoded.error) {
      throw new Error(`MCP ${method} failed: ${decoded.error.message ?? "unknown error"}`);
    }
    return decoded.result;
  }

  /** JSON-RPC notification: no id, no response decoded or required (MCP
   * spec) — but the POST itself is awaited so wire order is kept. */
  async function notify(method: string, signal?: AbortSignal): Promise<void> {
    try {
      const response = await opts.fetchImpl(opts.url, {
        method: "POST",
        headers: wireHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", method }),
        signal,
      });
      void response.text().catch(() => {}); // drain; notifications get 202/empty
    } catch {
      // Best-effort: a stateless server may reject the POST outright.
    }
  }

  async function ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (initialized) return;
    initialized = true;
    try {
      // Stateless servers (production) just answer the handshake; stateful
      // ones issue Mcp-Session-Id, which we capture and echo below.
      await rpc(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "lunaroute-opencode-extension", version: "web-tools" },
        },
        signal,
      );
      await notify("notifications/initialized", signal);
    } catch {
      // Stateless servers may reject initialize; tools/call still works.
    }
  }

  return {
    async listTools(signal) {
      await ensureInitialized(signal);
      const result = (await rpc("tools/list", undefined, signal)) as { tools?: { name?: string }[] } | undefined;
      return (result?.tools ?? [])
        .map((t) => t.name)
        .filter((n): n is string => typeof n === "string");
    },
    async listToolDescriptors(signal) {
      await ensureInitialized(signal);
      const result = (await rpc("tools/list", undefined, signal)) as
        | { tools?: { name?: string; inputSchema?: unknown }[] }
        | undefined;
      return (result?.tools ?? []).filter(
        (t): t is { name: string; inputSchema?: unknown } => typeof t.name === "string",
      );
    },
    async callTool(name, args, signal) {
      await ensureInitialized(signal);
      const result = (await rpc("tools/call", { name, arguments: args }, signal)) as McpToolCallResult | undefined;
      if (!result) throw new Error(`MCP tool ${name} returned no result`);
      if (result.isError) {
        const text = result.content?.map((c) => c.text ?? "").join("\n").trim();
        throw new Error(text || `MCP tool ${name} returned an error`);
      }
      return result;
    },
  };
}

// ============================================================================
// web_search result shaping (pi parity, minus truncation — the host does it)
// ============================================================================

export interface WebSearchResultItem {
  title?: string;
  url?: string;
  snippet?: string;
  published_date?: string | null;
  score?: number | null;
}

export interface WebSearchPayload {
  query: string;
  provider: string;
  results: WebSearchResultItem[];
  /** Set when the server text was not the expected JSON payload. */
  rawText?: string;
}

/** Trust boundary: the server payload is untrusted remote input — normalize
 * each result to the known fields (drop non-objects and non-string fields)
 * so formatting can never throw on malformed shapes. */
function sanitizeResult(r: unknown): WebSearchResultItem | null {
  if (typeof r !== "object" || r === null || Array.isArray(r)) return null;
  const o = r as Record<string, unknown>;
  return {
    title: typeof o.title === "string" ? o.title : undefined,
    url: typeof o.url === "string" ? o.url : undefined,
    snippet: typeof o.snippet === "string" ? o.snippet : undefined,
    published_date: typeof o.published_date === "string" ? o.published_date : null,
    score: typeof o.score === "number" ? o.score : null,
  };
}

/** Parse the normalized {query, provider, results[]} payload the MCP tool
 * returns as its content text. Tolerant: any parse failure keeps the raw
 * text so the model still sees what the server sent. */
export function parseWebSearchPayload(text: string): WebSearchPayload {
  try {
    const parsed = JSON.parse(text) as Partial<WebSearchPayload>;
    return {
      query: typeof parsed.query === "string" ? parsed.query : "",
      provider: typeof parsed.provider === "string" ? parsed.provider : "",
      results: Array.isArray(parsed.results)
        ? parsed.results.map(sanitizeResult).filter((r): r is WebSearchResultItem => r !== null)
        : [],
    };
  } catch {
    return { query: "", provider: "", results: [], rawText: text };
  }
}

function formatResultItem(item: WebSearchResultItem, index: number): string {
  const lines: string[] = [];
  const title = item.title?.trim() || "(untitled)";
  const url = item.url?.trim() || "";
  lines.push(`${index + 1}. ${title}`);
  if (url) lines.push(`   ${url}`);
  if (item.snippet?.trim()) lines.push(`   ${item.snippet.trim()}`);
  if (item.published_date) lines.push(`   published: ${item.published_date}`);
  return lines.join("\n");
}

/** Format the payload as the text content sent to the LLM. Full text —
 * never truncated here: OpenCode truncates/spills plugin tool output
 * itself (metadata.truncated + outputPath), so double-truncating would
 * lose content the host would have kept. */
export function formatWebSearchForModel(payload: WebSearchPayload): string {
  if (payload.rawText !== undefined) return payload.rawText;
  if (payload.results.length === 0) {
    return `No results${payload.query ? ` for "${payload.query}"` : ""}${
      payload.provider ? ` (provider: ${payload.provider})` : ""
    }.`;
  }
  const header = `Web search${payload.query ? ` for "${payload.query}"` : ""}${
    payload.provider ? ` via ${payload.provider}` : ""
  } — ${payload.results.length} result(s):`;
  return [header, ...payload.results.map(formatResultItem)].join("\n\n");
}

// ============================================================================
// Tool definitions
// ============================================================================

export interface WebToolExecuteDeps {
  /** Server-side MCP tool name (resolved from tools/list, not assumed). */
  mcpToolName: string;
  /** One stateless call: resolves the CURRENT key (lazy re-read), builds a
   * fresh client, and dispatches. Concurrent executes share nothing. */
  callServer: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpToolCallResult>;
  /** Default search provider resolved at CALL time from the settings file
   * (source of truth — a change applies to the very next search without
   * re-registration). Returning undefined = server default (the key is
   * omitted on the wire). The per-call param still wins. */
  defaultProvider?: () => string | undefined;
}

export const WEB_SEARCH_DESCRIPTION =
  "Search the web through LunaRoute. Returns normalized results (title, url, snippet, date). " +
  "Issue multiple web_search calls in one message to run searches in parallel.";

export function buildWebSearchTool(deps: WebToolExecuteDeps): ToolDefinition {
  return tool({
    description: WEB_SEARCH_DESCRIPTION,
    args: {
      query: tool.schema.string().describe("Search query"),
      count: tool.schema.number().min(1).max(20).describe("Number of results to return (server default applies)").optional(),
      provider: tool.schema.string().describe("Optional search provider override (as supported by the server)").optional(),
    },
    async execute(args, context) {
      // Per-call provider param wins; the default is resolved at call time
      // from the settings file (source of truth — kata decision 3).
      const provider = args.provider ?? deps.defaultProvider?.();
      const call = await deps.callServer(
        deps.mcpToolName,
        { query: args.query, count: args.count, ...(provider !== undefined && { provider }) },
        context.abort,
      );
      const payload = parseWebSearchPayload(call.content?.[0]?.text ?? "");
      return {
        title: `web_search: ${args.query}`,
        output: formatWebSearchForModel(payload),
        metadata: { provider: payload.provider || undefined, resultCount: payload.results.length },
      };
    },
  });
}

/** web_fetch is registered only when the hosted MCP server actually offers
 * a fetch tool (it does not as of pi v0.9.0 — tools/list gates registration).
 * Server-side contract still open (pi akyg); the schema below is pi's minimal
 * expected shape and is a passthrough. */
export function buildWebFetchTool(deps: Omit<WebToolExecuteDeps, "defaultProvider">): ToolDefinition {
  return tool({
    description: "Fetch a web page as text via LunaRoute.",
    args: {
      url: tool.schema.string().describe("URL to fetch"),
    },
    async execute(args, context) {
      const call = await deps.callServer(deps.mcpToolName, { url: args.url }, context.abort);
      const text = call.content?.map((c) => c.text ?? "").join("\n") ?? "";
      return { title: `web_fetch: ${args.url}`, output: text };
    },
  });
}

// ============================================================================
// Registration gate
// ============================================================================

export const WEB_TOOLS_PROBE_TIMEOUT_MS = 5000;

export interface ServerProbeOpts {
  url: string;
  key: string;
  sessionId: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** One tools/list probe with the resolved key — shared by the web-tools and
 * image-tools gates so an instance creation costs one round trip, not two
 * (both gates consume the same server view). Throws on failure; callers
 * decide warn/skip semantics. */
export async function listServerToolDescriptors(opts: ServerProbeOpts): Promise<{ name: string; inputSchema?: unknown }[]> {
  const client = createLunarouteMcpClient({
    url: opts.url,
    headers: { "LUNAROUTE-API-KEY": opts.key, ...buildAttributionHeaders(opts.sessionId) },
    fetchImpl: opts.fetchImpl ?? (fetch as FetchLike),
  });
  return client.listToolDescriptors(AbortSignal.timeout(opts.timeoutMs ?? WEB_TOOLS_PROBE_TIMEOUT_MS));
}

export interface WebToolMapDeps {
  env: NodeJS.ProcessEnv;
  mcpUrl: string;
  sessionId: string;
  fetchImpl?: FetchLike;
  log?: (level: "info" | "warn", message: string) => void;
  /** Auth resolution — invoked once for the gate and again per execute
   * (lazy re-read: key rotation reaches registered tools without reload). */
  resolveKey: () => Promise<AuthResolution>;
  /** Fresh settings read (file = source of truth), per gate and per execute. */
  readSettingsNow: () => LunarouteSettings;
  /** Pre-fetched tools/list descriptors (the shared probe in index.ts).
   * When present the gate skips its own probe; direct callers (tests) omit
   * it and the gate probes itself. */
  descriptors?: { name: string; inputSchema?: unknown }[];
}

function authErrorMessage(resolution: AuthResolution): string {
  if (resolution.state === "logged-out") {
    return "LunaRoute: logged out since this session started — run /connect and choose LunaRoute to log in again.";
  }
  if (resolution.state === "indeterminate") {
    return `LunaRoute: auth store unreadable (${resolution.reason}) — cannot call LunaRoute web tools.`;
  }
  return "LunaRoute: auth state unavailable — cannot call LunaRoute web tools.";
}

/** Build the first-class web tool map. Never throws; every failure path
 * returns fewer (or no) tools, exactly like pi's optional registration. */
export async function buildWebToolMap(deps: WebToolMapDeps): Promise<Record<string, ToolDefinition>> {
  if (!webToolsEnabled(deps.env, deps.readSettingsNow())) return {};

  const resolution = await deps.resolveKey();
  if (resolution.state !== "valid") return {}; // logged out / indeterminate → no tools, silent

  const headers = (key: string): Record<string, string> => ({
    "LUNAROUTE-API-KEY": key,
    ...buildAttributionHeaders(deps.sessionId),
  });
  const fetchImpl = deps.fetchImpl ?? (fetch as FetchLike);

  // Fresh client + fresh key per call: rotation reach-through, and nothing
  // shared between concurrent executes (the client's only state is a JSON-RPC
  // id counter, and each client here is per-call anyway).
  const callServer = async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult> => {
    const current = await deps.resolveKey();
    if (current.state !== "valid") throw new Error(authErrorMessage(current));
    return createLunarouteMcpClient({ url: deps.mcpUrl, headers: headers(current.key), fetchImpl }).callTool(name, args, signal);
  };

  // Probe: consult tools/list with the resolved key (short timeout — this
  // runs on the plugin-invocation path). Failures are not cached; the next
  // invocation retries. Skipped entirely when descriptors were pre-fetched
  // by the shared probe.
  let serverTools: string[];
  if (deps.descriptors) {
    serverTools = deps.descriptors.map((d) => d.name);
  } else {
    try {
      serverTools = await createLunarouteMcpClient({ url: deps.mcpUrl, headers: headers(resolution.key), fetchImpl }).listTools(
        AbortSignal.timeout(WEB_TOOLS_PROBE_TIMEOUT_MS),
      );
    } catch (err) {
      deps.log?.("warn", `LunaRoute: web tools not registered (tools/list failed: ${err instanceof Error ? err.message : String(err)})`);
      return {};
    }
  }

  const searchTool = pickServerTool(serverTools, WEB_SEARCH_TOOL_PATTERNS, deps.env[LUNAROUTE_ENV_MCP_WEB_SEARCH_TOOL]);
  const fetchTool = pickServerTool(serverTools, WEB_FETCH_TOOL_PATTERNS, deps.env[LUNAROUTE_ENV_MCP_WEB_FETCH_TOOL]);

  const map: Record<string, ToolDefinition> = {};
  if (searchTool) {
    map.web_search = buildWebSearchTool({
      mcpToolName: searchTool,
      callServer,
      defaultProvider: () => resolveSearchProvider(deps.readSettingsNow()),
    });
  }
  if (fetchTool) map.web_fetch = buildWebFetchTool({ mcpToolName: fetchTool, callServer });
  return map;
}
