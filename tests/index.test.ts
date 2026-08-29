import { describe, it, expect, vi } from "vitest";
import { createLunaroutePlugin, type LunaouteHooks, type TestClient } from "../src/index.js";

const ENV = {
  LUNAROUTE_ROUTING_URL: "http://gw/v1",
  LUNAROUTE_API_URL: "http://api",
  LUNAROUTE_FRONT_URL: "http://front",
  LUNAROUTE_MCP_URL: "http://mcp",
};
const AUTH_PATH = "/fake/home/.local/share/opencode/auth.json";

const fsWith = (entry: unknown) => ({
  readFile: async () => JSON.stringify({ lunaroute: entry }),
});
const fsThrowing = () => ({
  readFile: async () => {
    throw new Error("EACCES");
  },
});

function makePlugin(overrides: { client?: TestClient } = {}) {
  const logs: { level: string; message: string }[] = [];
  const plugin = createLunaroutePlugin({
    env: ENV as NodeJS.ProcessEnv,
    home: "/fake/home",
    log: (level: "info" | "warn", message: string) => logs.push({ level, message }),
    ...overrides,
  });
  return { plugin, logs };
}

// postLoginRefresh is fire-and-forget from onLoginSuccess — flush microtasks
// before asserting its side effects.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

const apiOf = (hooks: LunaouteHooks) =>
  hooks.auth.methods.find((m) => m.type === "api") as {
    type: "api";
    authorize: (inputs?: Record<string, string>) => Promise<unknown>;
  };

const providerOf = (cfg: Record<string, unknown>) =>
  (cfg.provider as Record<string, Record<string, unknown>>).lunaroute;
const mcpOf = (cfg: Record<string, unknown>) =>
  (cfg.mcp as Record<string, { headers: Record<string, string> }>).lunaroute;

describe("config hook", () => {
  it("injects provider stub + models + MCP when a valid key exists; memo prevents refetch on second run", async () => {
    const fs = fsWith({ type: "api", key: "lr_good" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "m-1" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { plugin } = makePlugin();
      const hooks = await plugin({});
      const cfg: Record<string, unknown> = {};
      await hooks.config(cfg, { storeKey: AUTH_PATH, fs });
      expect(providerOf(cfg)).toMatchObject({ options: { baseURL: "http://gw/v1" } });
      expect(providerOf(cfg).models).toHaveProperty("m-1");
      expect(mcpOf(cfg).headers["LUNAROUTE-API-KEY"]).toBe("lr_good");
      const cfg2: Record<string, unknown> = {};
      await hooks.config(cfg2, { storeKey: AUTH_PATH, fs });
      expect(fetchMock).toHaveBeenCalledTimes(1); // memoized per credential
      expect(providerOf(cfg2).models).toHaveProperty("m-1");
      expect(mcpOf(cfg2).headers["LUNAROUTE-API-KEY"]).toBe("lr_good");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("logged out: provider stub only — no models, no MCP, fetch untouched, one first-run hint", async () => {
    const fs = fsWith(undefined); // readable store, no lunaroute entry
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { plugin, logs } = makePlugin();
      const hooks = await plugin({});
      const cfg: Record<string, unknown> = {};
      await hooks.config(cfg, { storeKey: AUTH_PATH, fs });
      expect(providerOf(cfg)).toBeDefined();
      expect(providerOf(cfg).models).toBeUndefined();
      expect((cfg.mcp as Record<string, unknown> | undefined)?.lunaroute).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logs).toEqual([{ level: "info", message: "Run /connect and choose LunaRoute to start using LunaRoute." }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("indeterminate (unreadable store): stub lands, models + MCP untouched, silent — per-contributor error isolation", async () => {
    const { plugin, logs } = makePlugin();
    const hooks = await plugin({});
    const cfg: Record<string, unknown> = {};
    await hooks.config(cfg, { storeKey: AUTH_PATH, fs: fsThrowing() });
    expect(providerOf(cfg)).toBeDefined();
    expect(providerOf(cfg).models).toBeUndefined();
    expect((cfg.mcp as Record<string, unknown> | undefined)?.lunaroute).toBeUndefined();
    // Spec's normative indeterminate logging rule: silent no-op when nothing was retained.
    expect(logs).toEqual([]);
  });

  it("catalog fetch failure: stub + MCP land, no models, one warn", async () => {
    const fs = fsWith({ type: "api", key: "lr_good" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("gateway down")));
    try {
      const { plugin, logs } = makePlugin();
      const hooks = await plugin({});
      const cfg: Record<string, unknown> = {};
      await hooks.config(cfg, { storeKey: AUTH_PATH, fs });
      expect(providerOf(cfg).models).toBeUndefined();
      expect(mcpOf(cfg).headers["LUNAROUTE-API-KEY"]).toBe("lr_good");
      expect(logs.some((l) => l.level === "warn" && /catalog/.test(l.message))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("chat.headers", () => {
  it("adds the attribution triple only for the lunaroute provider", async () => {
    const { plugin } = makePlugin();
    const hooks = await plugin({});
    const out: { headers: Record<string, string> } = { headers: {} };
    await hooks["chat.headers"]({ provider: { info: { id: "lunaroute" } } }, out);
    expect(out.headers["lunaroute-agent"]).toBe("opencode");
    expect(out.headers["x-lunaroute-session"]).toBeDefined();
    expect(out.headers["lunaroute-session-id"]).toBeDefined();
    const out2: { headers: Record<string, string> } = { headers: {} };
    await hooks["chat.headers"]({ provider: { info: { id: "anthropic" } } }, out2);
    expect(out2.headers).toEqual({});
  });

  it("shares one session id between chat headers and MCP injection", async () => {
    const fs = fsWith({ type: "api", key: "lr_good" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "m-1" }] }) }));
    try {
      const { plugin } = makePlugin();
      const hooks = await plugin({});
      const cfg: Record<string, unknown> = {};
      await hooks.config(cfg, { storeKey: AUTH_PATH, fs });
      const mcpSession = mcpOf(cfg).headers["lunaroute-session-id"];
      const out: { headers: Record<string, string> } = { headers: {} };
      await hooks["chat.headers"]({ provider: { info: { id: "lunaroute" } } }, out);
      expect(out.headers["lunaroute-session-id"]).toBe(mcpSession);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("post-login model auto-pick", () => {
  const catalogFetch = () => vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "m-1" }] }) });
  const makeClient = (configGet: ReturnType<typeof vi.fn>) => {
    const configUpdate = vi.fn();
    return { client: { config: { get: configGet, update: configUpdate } } as unknown as TestClient, configUpdate };
  };

  it("writes exactly { model } when unset", async () => {
    const configGet = vi.fn().mockResolvedValue({ data: {} });
    const { client, configUpdate } = makeClient(configGet);
    const { plugin } = makePlugin({ client });
    vi.stubGlobal("fetch", catalogFetch());
    const hooks = await plugin({ client });
    try {
      await apiOf(hooks).authorize({ api_key: "lr_good" });
      await flush();
      expect(configUpdate).toHaveBeenCalledTimes(1);
      expect(configUpdate).toHaveBeenCalledWith({ config: { model: "lunaroute/m-1" } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips when a model is already set", async () => {
    const configGet = vi.fn().mockResolvedValue({ data: { model: "anthropic/x" } });
    const { client, configUpdate } = makeClient(configGet);
    const { plugin } = makePlugin({ client });
    vi.stubGlobal("fetch", catalogFetch());
    const hooks = await plugin({ client });
    try {
      await apiOf(hooks).authorize({ api_key: "lr_good" });
      await flush();
      expect(configUpdate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("re-read guard: model set between the initial read and the write → no update", async () => {
    // First get (initial read): unset. Second get (re-read guard): model set (a
    // concurrent selection) → the pick is skipped, nothing is overwritten.
    const configGet = vi.fn().mockResolvedValue({ data: {} }).mockResolvedValueOnce({ data: {} }).mockResolvedValueOnce({ data: { model: "anthropic/x" } });
    const { client, configUpdate } = makeClient(configGet);
    const { plugin } = makePlugin({ client });
    vi.stubGlobal("fetch", catalogFetch());
    const hooks = await plugin({ client });
    try {
      await apiOf(hooks).authorize({ api_key: "lr_good" });
      await flush();
      expect(configUpdate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("catalog fetch failure after login: logged, not thrown, no update", async () => {
    const configGet = vi.fn().mockResolvedValue({ data: {} });
    const { client, configUpdate } = makeClient(configGet);
    const { plugin, logs } = makePlugin({ client });
    // Fetch call #1 = paste-key validation (ok); call #2 = post-login catalog fetch (fails).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: "m-1" }] }) }).mockRejectedValueOnce(new Error("gateway down")),
    );
    const hooks = await plugin({ client });
    try {
      await expect(apiOf(hooks).authorize({ api_key: "lr_good" })).resolves.toBeDefined();
      await flush();
      expect(configUpdate).not.toHaveBeenCalled();
      expect(logs.some((l) => l.level === "warn" && /post-login/.test(l.message))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
