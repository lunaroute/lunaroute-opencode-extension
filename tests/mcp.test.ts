import { describe, it, expect } from "vitest";
import { createMcpReconciler, isManagedShape, resolveAuthState, resolveAuthStorePath } from "../src/mcp.js";
import { credentialFingerprint } from "../src/lunaroute.js";

const MCP_URL = "https://mcp.lunaroute.com/mcp";
const KEY_A = "lr_aaaaaaaaaa";
const KEY_B = "lr_bbbbbbbbbb";

function memFS(files: Record<string, string | Error>): { readFile: (p: string) => Promise<string> } {
  return {
    readFile: async (p) => {
      const v = files[p];
      if (v instanceof Error) throw v;
      if (v === undefined) {
        const e = new Error("ENOENT") as NodeJS.ErrnoException;
        e.code = "ENOENT";
        throw e;
      }
      return v;
    },
  };
}
const store = (entry: unknown) => JSON.stringify({ lunaroute: entry });
const managedEntry = (key: string): Record<string, unknown> => ({
  type: "remote",
  url: MCP_URL,
  oauth: false,
  enabled: true,
  headers: { "LUNAROUTE-API-KEY": key, "lunaroute-agent": "opencode", "x-lunaroute-session": "s", "lunaroute-session-id": "s" },
});
const cfgWith = (entry: unknown) => ({ mcp: { lunaroute: entry } }) as Record<string, unknown>;

describe("auth resolver (tri-state)", () => {
  const p = "/store/auth.json";
  it("valid: readable + shaped credential (api and oauth shapes)", async () => {
    expect(await resolveAuthState(p, memFS({ [p]: store({ type: "api", key: KEY_A }) }))).toEqual({ state: "valid", key: KEY_A });
    expect(await resolveAuthState(p, memFS({ [p]: store({ type: "oauth", access: KEY_A, refresh: "", expires: 1 }) }))).toEqual({ state: "valid", key: KEY_A });
  });
  it("logged-out: readable store, entry absent", async () => {
    expect(await resolveAuthState(p, memFS({ [p]: JSON.stringify({}) }))).toEqual({ state: "logged-out" });
    expect(await resolveAuthState(p, memFS({ [p]: JSON.stringify({ other: { type: "api", key: "x" } }) }))).toEqual({ state: "logged-out" });
  });
  it("indeterminate: missing, unparseable, unreadable, non-object store", async () => {
    expect(await resolveAuthState(p, memFS({}))).toMatchObject({ state: "indeterminate" });
    expect(await resolveAuthState(p, memFS({ [p]: "{nope" }))).toMatchObject({ state: "indeterminate" });
    expect(await resolveAuthState(p, memFS({ [p]: "[1]" }))).toMatchObject({ state: "indeterminate" });
    expect(await resolveAuthState(p, memFS({ [p]: new Error("EACCES") }))).toMatchObject({ state: "indeterminate" });
  });
  it("indeterminate: present-but-invalid record shapes", async () => {
    for (const bad of [null, [], 5, {}, { type: "api" }, { type: "api", key: "" }, { type: "api", key: "bad\n" }, { type: "oauth" }]) {
      expect(await resolveAuthState(p, memFS({ [p]: store(bad) }))).toMatchObject({ state: "indeterminate" });
    }
  });
  it("store path: XDG override and default", () => {
    expect(resolveAuthStorePath({ XDG_DATA_HOME: "/xdg" }, "/home/u")).toBe("/xdg/opencode/auth.json");
    expect(resolveAuthStorePath({}, "/home/u")).toBe("/home/u/.local/share/opencode/auth.json");
  });
});

describe("value-shape recognition (accept)", () => {
  it("matches our exact shape, ignoring the key value", () => {
    expect(isManagedShape(managedEntry(KEY_A), MCP_URL)).toBe(true);
    expect(isManagedShape(managedEntry(KEY_B), MCP_URL)).toBe(true);
  });
  it("case-insensitive header names normalize to ours", () => {
    const caseVaried = managedEntry(KEY_A);
    caseVaried.headers = { "lunaroute-api-key": KEY_A, "LUNAROUTE-AGENT": "opencode", "x-lunaroute-session": "s", "lunaroute-session-id": "s" };
    expect(isManagedShape(caseVaried, MCP_URL)).toBe(true);
  });
  it("extra top-level fields are tolerated (host normalization)", () => {
    expect(isManagedShape({ ...managedEntry(KEY_A), extra: 1 }, MCP_URL)).toBe(true);
  });
});

describe("value-shape recognition (reject)", () => {
  it("wrong type", () => {
    expect(isManagedShape({ type: "local", command: [] }, MCP_URL)).toBe(false);
  });
  it("different url", () => {
    expect(isManagedShape({ ...managedEntry(KEY_A), url: "https://elsewhere" }, MCP_URL)).toBe(false);
  });
  it("oauth true", () => {
    expect(isManagedShape({ ...managedEntry(KEY_A), oauth: true }, MCP_URL)).toBe(false);
  });
  it("enabled false", () => {
    expect(isManagedShape({ ...managedEntry(KEY_A), enabled: false }, MCP_URL)).toBe(false);
  });
  it("missing header (header-name set differs)", () => {
    const e = managedEntry(KEY_A);
    delete (e.headers as Record<string, unknown>)["lunaroute-agent"];
    expect(isManagedShape(e, MCP_URL)).toBe(false);
  });
  it("extra header (header-name set differs)", () => {
    const e: Record<string, unknown> = managedEntry(KEY_A);
    (e.headers as Record<string, unknown>)["extra-header"] = "x";
    expect(isManagedShape(e, MCP_URL)).toBe(false);
  });
  it("duplicate logical header names (case-folded collision)", () => {
    const e: Record<string, unknown> = managedEntry(KEY_A);
    (e.headers as Record<string, unknown>)["LUNAROUTE-api-key"] = KEY_A;
    expect(isManagedShape(e, MCP_URL)).toBe(false);
  });
  it("non-object and undefined entries", () => {
    expect(isManagedShape(undefined, MCP_URL)).toBe(false);
    expect(isManagedShape("nope", MCP_URL)).toBe(false);
    expect(isManagedShape(null, MCP_URL)).toBe(false);
  });
});

describe("reconciler (matrix)", () => {
  function setup() {
    const logs: { level: string; message: string }[] = [];
    const log = (level: "info" | "warn", message: string) => logs.push({ level, message });
    const r = createMcpReconciler(MCP_URL, log, "sess-1");
    return { r, logs };
  }
  const SK = "/store/auth.json";

  it("valid + absent → inject (records fingerprint; attribution shares the session id)", () => {
    const { r } = setup();
    const cfg: Record<string, unknown> = {};
    r.reconcile(cfg, { state: "valid", key: KEY_A }, SK);
    const entry = (cfg.mcp as Record<string, Record<string, unknown>>).lunaroute;
    expect(entry).toBeDefined();
    expect((entry.headers as Record<string, string>)["LUNAROUTE-API-KEY"]).toBe(KEY_A);
    expect((entry.headers as Record<string, string>)["lunaroute-session-id"]).toBe("sess-1");
    expect((entry.headers as Record<string, string>)["lunaroute-agent"]).toBe("opencode");
  });
  it("valid + ours → replace header values with current key", () => {
    const { r } = setup();
    const cfg = cfgWith(managedEntry(KEY_A));
    r.reconcile(cfg, { state: "valid", key: KEY_B }, SK);
    const entry = (cfg.mcp as Record<string, Record<string, unknown>>).lunaroute as { headers: Record<string, string> };
    expect(entry.headers["LUNAROUTE-API-KEY"]).toBe(KEY_B);
  });
  it("valid + user-owned → untouched + info log", () => {
    const { r, logs } = setup();
    const cfg = cfgWith({ type: "remote", url: "https://mine", headers: { A: "b" } });
    r.reconcile(cfg, { state: "valid", key: KEY_A }, SK);
    expect((cfg.mcp as Record<string, unknown>).lunaroute).toEqual({ type: "remote", url: "https://mine", headers: { A: "b" } });
    expect(logs.some((l) => l.level === "info" && /user-defined mcp/.test(l.message))).toBe(true);
  });
  it("logged-out + absent → nothing", () => {
    const { r } = setup();
    const cfg: Record<string, unknown> = {};
    r.reconcile(cfg, { state: "logged-out" }, SK);
    expect(cfg).toEqual({});
  });
  it("logged-out + ours (fingerprint known) → removed", () => {
    const { r } = setup();
    const cfg = cfgWith(managedEntry(KEY_A));
    r.reconcile(cfg, { state: "valid", key: KEY_A }, SK); // inject first
    r.reconcile(cfg, { state: "logged-out" }, SK);
    expect((cfg.mcp as Record<string, unknown>).lunaroute).toBeUndefined();
  });
  it("logged-out + ours (unknown credential) → retained + info log", () => {
    const { r, logs } = setup();
    const cfg = cfgWith(managedEntry("lr_unknown_key"));
    r.reconcile(cfg, { state: "logged-out" }, SK);
    expect((cfg.mcp as Record<string, unknown>).lunaroute).toBeDefined();
    expect(logs.some((l) => /unknown credential/.test(l.message))).toBe(true);
  });
  it("indeterminate + managed entry → retained + one warn", () => {
    const { r, logs } = setup();
    const cfg = cfgWith(managedEntry(KEY_A));
    r.reconcile(cfg, { state: "indeterminate", reason: "auth store missing" }, SK);
    expect((cfg.mcp as Record<string, unknown>).lunaroute).toBeDefined();
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(1);
  });
  it("indeterminate + nothing to retain → silent no-op", () => {
    const { r, logs } = setup();
    const cfg: Record<string, unknown> = {};
    r.reconcile(cfg, { state: "indeterminate", reason: "auth store missing" }, SK);
    expect(logs).toEqual([]);
  });
});

describe("multi-generation + isolation + eviction", () => {
  const SK = "/store/auth.json";
  it("rotation across generations: both cleaned on logout", () => {
    const logs: { level: string; message: string }[] = [];
    const r = createMcpReconciler(MCP_URL, (l, m) => logs.push({ level: l, message: m }), "sess-1");
    const gen1 = cfgWith(managedEntry(KEY_A));
    const gen2: Record<string, unknown> = {};
    r.reconcile(gen1, { state: "valid", key: KEY_A }, SK);
    r.reconcile(gen2, { state: "valid", key: KEY_B }, SK);
    r.reconcile(gen1, { state: "logged-out" }, SK);
    r.reconcile(gen2, { state: "logged-out" }, SK);
    expect((gen1.mcp as Record<string, unknown>).lunaroute).toBeUndefined();
    expect((gen2.mcp as Record<string, unknown>).lunaroute).toBeUndefined();
  });
  it("eviction bound, both sides: 2–9 removed, 1 retained", () => {
    const r = createMcpReconciler(MCP_URL, () => {}, "sess-1");
    const gens: Record<string, unknown>[] = [];
    for (let i = 1; i <= 9; i++) {
      const g: Record<string, unknown> = {};
      r.reconcile(g, { state: "valid", key: `lr_k${i}` }, SK);
      gens.push(g);
    }
    for (const g of gens) r.reconcile(g, { state: "logged-out" }, SK);
    for (let i = 1; i <= 9; i++) {
      const entry = (gens[i - 1].mcp as Record<string, unknown>).lunaroute;
      if (i === 1) expect(entry).toBeDefined();  // evicted fingerprint → retained
      else expect(entry).toBeUndefined();         // still tracked → removed
    }
  });
  it("re-injection refreshes eviction position (both sides)", () => {
    const r = createMcpReconciler(MCP_URL, () => {}, "sess-1");
    // k1 injected first; then k2..k8 fill the set; refreshing k1 moves it to most-recent;
    // adding k9 evicts k2 (oldest by write), NOT k1.
    const k1gen: Record<string, unknown> = {};
    r.reconcile(k1gen, { state: "valid", key: "lr_k1" }, SK);
    const g: Record<string, unknown> = {};
    for (let i = 2; i <= 8; i++) r.reconcile(g, { state: "valid", key: `lr_k${i}` }, SK);
    r.reconcile(g, { state: "valid", key: "lr_k1" }, SK); // refresh k1 to most-recent
    r.reconcile(g, { state: "valid", key: "lr_k9" }, SK); // evicts k2, not k1
    r.reconcile(k1gen, { state: "logged-out" }, SK); // k1 still tracked → removed (the refresh is what kept it known)
    expect((k1gen.mcp as Record<string, unknown>).lunaroute).toBeUndefined();
    const k2gen = cfgWith(managedEntry("lr_k2")); // k2 was evicted → unknown → retained
    r.reconcile(k2gen, { state: "logged-out" }, SK);
    expect((k2gen.mcp as Record<string, unknown>).lunaroute).toBeDefined();
  });
  it("store-key isolation: logout in one store never touches another", () => {
    const r = createMcpReconciler(MCP_URL, () => {}, "sess-1");
    const g1 = cfgWith(managedEntry(KEY_A));
    const g2 = cfgWith(managedEntry(KEY_A));
    r.reconcile(g1, { state: "valid", key: KEY_A }, "/s1/auth.json");
    r.reconcile(g2, { state: "valid", key: KEY_A }, "/s2/auth.json");
    r.reconcile(g1, { state: "logged-out" }, "/s1/auth.json");
    expect((g1.mcp as Record<string, unknown>).lunaroute).toBeUndefined();
    expect((g2.mcp as Record<string, unknown>).lunaroute).toBeDefined();
  });
  it("store-key lifecycle: same logical store across present→missing→restored (lexical key)", () => {
    const r = createMcpReconciler(MCP_URL, () => {}, "sess-1");
    const g = cfgWith(managedEntry(KEY_A));
    r.reconcile(g, { state: "valid", key: KEY_A }, SK);
    r.reconcile(g, { state: "indeterminate", reason: "auth store missing" }, SK); // missing interval: retain
    expect((g.mcp as Record<string, unknown>).lunaroute).toBeDefined();
    r.reconcile(g, { state: "valid", key: KEY_A }, SK); // restored: refresh
    r.reconcile(g, { state: "logged-out" }, SK); // logout: remove
    expect((g.mcp as Record<string, unknown>).lunaroute).toBeUndefined();
  });
});

describe("redaction", () => {
  it("no credential material in any log line (current, historical, malformed)", () => {
    const logs: string[] = [];
    const r = createMcpReconciler(MCP_URL, (_l, m) => logs.push(m), "sess-1");
    const g = cfgWith(managedEntry(KEY_A));
    r.reconcile(g, { state: "valid", key: KEY_A }, "/s/auth.json");
    r.reconcile(g, { state: "indeterminate", reason: "auth store unparseable" }, "/s/auth.json");
    r.reconcile(g, { state: "logged-out" }, "/s/auth.json");
    for (const line of logs) {
      expect(line).not.toContain(KEY_A);
      expect(line).not.toContain(credentialFingerprint(KEY_A));
    }
  });
});
