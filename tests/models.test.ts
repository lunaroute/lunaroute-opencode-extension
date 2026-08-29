import { describe, it, expect, vi } from "vitest";
import { createCatalogMemo, fetchCatalog, injectModels, injectProviderStub, toProviderModels } from "../src/models.js";
import type { MappedModel } from "../src/lunaroute.js";

const mk = (id: string): MappedModel => ({ id, name: id, reasoning: false, tool_call: true, attachment: false, limitContext: 64000, limitOutput: 4096, modalitiesInput: ["text"], variants: {} });

describe("fetchCatalog", () => {
  it("fetches with bearer + attribution, maps entries, reports skips", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "m-1" }, { id: "m-1" }, null] }) });
    const r = await fetchCatalog("http://gw/v1", "lr_k", "sess-1", { fetch: fetchMock as never });
    expect(r).toHaveProperty("models");
    if ("models" in r) {
      expect(r.models.map((m) => m.id)).toEqual(["m-1"]);
      expect(r.skipped).toHaveLength(2);
    }
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gw/v1/models");
    expect(init.headers["Authorization"]).toBe("Bearer lr_k");
    expect(init.headers["lunaroute-agent"]).toBe("opencode");
    expect(init.headers["x-lunaroute-session"]).toBe("sess-1");
  });
  it("returns error on !ok and on fetch failure", async () => {
    expect(await fetchCatalog("http://gw/v1", "lr_k", "sess-1", { fetch: vi.fn().mockResolvedValue({ ok: false, status: 401 }) as never })).toEqual({ error: "HTTP 401" });
    expect(await fetchCatalog("http://gw/v1", "lr_k", "sess-1", { fetch: vi.fn().mockRejectedValue(new Error("boom")) as never })).toEqual({ error: "boom" });
  });
  it("non-object body -> error", async () => {
    expect(await fetchCatalog("http://gw/v1", "lr_k", "sess-1", { fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => "nope" }) as never })).toHaveProperty("error");
  });
});

describe("toProviderModels", () => {
  it("produces the ModelV2 shape with api.url/npm, limits, variants, zeros cost", () => {
    const entry = Object.entries(toProviderModels([mk("m-1")], "http://gw/v1"))[0];
    const model = entry[1];
    expect(model).toMatchObject({
      id: "m-1", name: "m-1", providerID: "lunaroute", attachment: false, reasoning: false,
      tool_call: true, status: "active",
      api: { id: "m-1", url: "http://gw/v1", npm: "@ai-sdk/openai-compatible" },
      limit: { context: 64000, output: 4096 },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      modalities: { input: ["text"], output: ["text"] },
    });
  });
});

describe("injectProviderStub", () => {
  it("fills name/npm/baseURL when absent", () => {
    const cfg: Record<string, unknown> = {};
    injectProviderStub(cfg as never, "http://gw/v1");
    expect(cfg.provider).toEqual({ lunaroute: { name: "LunaRoute", npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://gw/v1" } } });
  });
  it("preserves user-set fields (name, npm, baseURL) and merges options", () => {
    const cfg: Record<string, unknown> = { provider: { lunaroute: { name: "My LR", npm: "custom-pkg", options: { baseURL: "http://staging/v1", extra: 1 } } } };
    injectProviderStub(cfg as never, "http://gw/v1");
    expect(cfg.provider).toEqual({ lunaroute: { name: "My LR", npm: "custom-pkg", options: { baseURL: "http://staging/v1", extra: 1 } } });
  });
  it("never sets models", () => {
    const cfg: Record<string, unknown> = {};
    injectProviderStub(cfg as never, "http://gw/v1");
    expect((cfg.provider as Record<string, unknown>).lunaroute).not.toHaveProperty("models");
  });
});

describe("injectModels", () => {
  it("sets provider.lunaroute.models from the mapped catalog (replaces prior)", () => {
    const cfg: Record<string, unknown> = {};
    injectProviderStub(cfg as never, "http://gw/v1");
    injectModels(cfg as never, [mk("m-1")], "http://gw/v1");
    const provider = (cfg.provider as Record<string, Record<string, unknown>>).lunaroute;
    expect(provider.models).toMatchObject({ "m-1": { id: "m-1", api: { url: "http://gw/v1" } } });
    injectModels(cfg as never, [mk("m-2")], "http://gw/v1");
    expect(Object.keys((cfg.provider as Record<string, Record<string, unknown>>).lunaroute.models!)).toEqual(["m-2"]);
  });
});

describe("createCatalogMemo", () => {
  it("shares one in-flight fetch for concurrent same-key calls; success is reused sequentially", async () => {
    let calls = 0;
    const slow = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { ok: true, json: async () => ({ data: [{ id: "m" }] }) }; };
    const memo = createCatalogMemo((k) => fetchCatalog("http://gw/v1", k, "sess-1", { fetch: slow as never }));
    const [a, b] = await Promise.all([memo("k"), memo("k")]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    const c = await memo("k"); // sequential reuse — no third fetch
    expect(calls).toBe(1);
    expect(c).toEqual(a);
  });
  it("does not cache failures; a different key refetches", async () => {
    let calls = 0;
    let fail = true;
    const flaky = async () => { calls++; if (fail) throw new Error("boom"); return { ok: true, json: async () => ({ data: [{ id: "m" }] }) }; };
    const memo = createCatalogMemo((k) => fetchCatalog("http://gw/v1", k, "sess-1", { fetch: flaky as never }));
    await memo("k"); // fails
    fail = false;
    const r = await memo("k"); // retries — failure was not cached
    expect(calls).toBe(2);
    expect(r).toHaveProperty("models");
    await memo("other"); // different key → refetch
    expect(calls).toBe(3);
  });
});
