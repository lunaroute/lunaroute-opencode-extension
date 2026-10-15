import { describe, it, expect, vi } from "vitest";
import { createLunarouteProvider, type ProviderCtxLike, type ProviderEditorLike } from "../src/provider.js";
import { PACKAGE_RESPONSES } from "../src/wire.js";
import type { CatalogResult } from "../src/models.js";
import type { MappedModel } from "../src/lunaroute.js";

const mapped: MappedModel = {
  id: "glm-5.3",
  name: "GLM 5.3",
  reasoning: true,
  tool_call: true,
  attachment: false,
  limitContext: 200_000,
  limitOutput: 16_384,
  modalitiesInput: ["text"],
  variants: { low: { reasoningEffort: "low" } },
};

type Added = { info: Record<string, unknown>; models: Record<string, unknown>[] };

function makeCtx(existing?: unknown) {
  const added: Added[] = [];
  const callbacks: ((editor: ProviderEditorLike) => void)[] = [];
  const editor: ProviderEditorLike = {
    get: (id: string) => (id === "lunaroute" ? (existing as never) : undefined),
    add: (input) => {
      added.push(input);
    },
  };
  // Mirrors the real contract: reload() replays every registered transform
  // against fresh state.
  const reload = vi.fn(async () => {
    for (const cb of callbacks) cb(editor);
  });
  const ctx: ProviderCtxLike = {
    provider: {
      transform: async (cb) => {
        callbacks.push(cb);
        cb(editor);
        return {};
      },
      reload,
    },
  };
  return { ctx, added, callbacks, reload };
}

const deps = (over: Partial<Parameters<typeof createLunarouteProvider>[0]> = {}) => ({
  routingUrl: "https://gw.example/v1",
  wirePackage: PACKAGE_RESPONSES,
  resolveKey: vi.fn(async () => "lr_key"),
  fetchCatalog: vi.fn(async (): Promise<CatalogResult> => ({ models: [mapped], skipped: [] })),
  log: vi.fn(),
  ...over,
});

describe("createLunarouteProvider", () => {
  it("registers the provider with the wire package, integration binding, and base URL", async () => {
    const d = deps();
    const provider = createLunarouteProvider(d);
    const { ctx, added } = makeCtx();
    await provider.register(ctx);

    expect(added).toHaveLength(1);
    const info = added[0].info as Record<string, unknown>;
    expect(info.id).toBe("lunaroute");
    expect(info.name).toBe("LunaRoute");
    expect(info.package).toBe(PACKAGE_RESPONSES);
    expect(info.integrationID).toBe("lunaroute");
    expect(info.settings).toEqual({ baseURL: "https://gw.example/v1" });
    expect(added[0].models.map((m) => m.id)).toEqual(["glm-5.3"]);
  });

  it("registers with zero models when logged out, without fetching", async () => {
    const d = deps({ resolveKey: vi.fn(async () => undefined) });
    const provider = createLunarouteProvider(d);
    const { ctx, added } = makeCtx();
    await provider.register(ctx);

    expect(d.fetchCatalog).not.toHaveBeenCalled();
    expect(added[0].models).toEqual([]);
  });

  it("starts with zero models and warns when the catalog fetch fails", async () => {
    const d = deps({ fetchCatalog: vi.fn(async (): Promise<CatalogResult> => ({ error: "HTTP 401" })) });
    const provider = createLunarouteProvider(d);
    const { ctx, added } = makeCtx();
    await provider.register(ctx);

    expect(added[0].models).toEqual([]);
    expect(d.log).toHaveBeenCalledWith("warn", expect.stringContaining("catalog fetch failed: HTTP 401"));
  });

  it("warns per skipped catalog entry", async () => {
    const d = deps({
      fetchCatalog: vi.fn(async (): Promise<CatalogResult> => ({
        models: [mapped],
        skipped: [{ id: "embed-x", reason: "non_chat_capability (embeddings)" }],
      })),
    });
    const provider = createLunarouteProvider(d);
    const { ctx } = makeCtx();
    await provider.register(ctx);
    expect(d.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining('skipped catalog entry "embed-x"'),
    );
  });

  it("preserves a user-pinned provider baseURL over the resolved default", async () => {
    const d = deps();
    const provider = createLunarouteProvider(d);
    const { ctx, added } = makeCtx({ provider: { settings: { baseURL: "https://custom.example/v1" } } });
    await provider.register(ctx);
    expect((added[0].info as Record<string, unknown>).settings).toEqual({
      baseURL: "https://custom.example/v1",
    });
  });

  it("uses a synchronous transform callback (v2 contract)", async () => {
    const d = deps();
    const provider = createLunarouteProvider(d);
    const { callbacks } = makeCtx();
    const ctx: ProviderCtxLike = {
      provider: {
        transform: async (cb) => {
          callbacks.push(cb);
          return {};
        },
        reload: vi.fn(async () => {}),
      },
    };
    await provider.register(ctx);
    const editor: ProviderEditorLike = { get: () => undefined, add: vi.fn() };
    expect(callbacks[0](editor)).toBeUndefined();
  });

  it("refresh re-fetches the catalog and replays the transform via provider.reload()", async () => {
    let models: MappedModel[] = [mapped];
    const fetchCatalog = vi.fn(async (): Promise<CatalogResult> => ({ models, skipped: [] }));
    const d = deps({ fetchCatalog });
    const provider = createLunarouteProvider(d);
    const { ctx, added, reload } = makeCtx();
    await provider.register(ctx);

    models = [{ ...mapped, id: "glm-5.4", name: "GLM 5.4" }];
    await provider.refresh(ctx);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
    expect(added[added.length - 1].models.map((m) => m.id)).toEqual(["glm-5.4"]);
  });

  it("refresh keeps the last good catalog on a failed fetch", async () => {
    let result: CatalogResult = { models: [mapped], skipped: [] };
    const d = deps({ fetchCatalog: vi.fn(async () => result) });
    const provider = createLunarouteProvider(d);
    const { ctx, added, reload } = makeCtx();
    await provider.register(ctx);

    result = { error: "HTTP 500" };
    await provider.refresh(ctx);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(added[added.length - 1].models.map((m) => m.id)).toEqual(["glm-5.3"]);
    expect(d.log).toHaveBeenCalledWith("warn", expect.stringContaining("HTTP 500"));
  });
});
