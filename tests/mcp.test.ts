import { describe, it, expect, vi } from "vitest";
import {
  buildMcpServer,
  createLunarouteMcp,
  normalizedUrlIdentity,
  type McpCtxLike,
  type McpEditorLike,
  type McpServerLike,
} from "../src/mcp.js";

type Entry = readonly [string, { url?: unknown }];

function makeCtx(entries: Entry[] = []) {
  const setCalls: { name: string; config: McpServerLike }[] = [];
  const callbacks: ((editor: McpEditorLike) => void)[] = [];
  const editor: McpEditorLike = {
    list: () => entries,
    get: (name) => entries.find(([n]) => n === name)?.[1],
    set: (name, config) => setCalls.push({ name, config }),
  };
  // reload() replays the registered transforms, like the real registry.
  const reload = vi.fn(async () => {
    for (const cb of callbacks) cb(editor);
  });
  const ctx: McpCtxLike = {
    mcp: {
      transform: async (cb) => {
        callbacks.push(cb);
        cb(editor);
        return {};
      },
      reload,
    },
  };
  return { ctx, setCalls, reload };
}

const opts = (over: Partial<Parameters<typeof createLunarouteMcp>[0]> = {}) => ({
  mcpUrl: "https://mcp.example/mcp",
  sessionId: "sess-1",
  log: vi.fn(),
  ...over,
});

describe("createLunarouteMcp", () => {
  it("registers the hosted server with key + attribution headers", async () => {
    const { ctx, setCalls } = makeCtx();
    await createLunarouteMcp(opts()).register(ctx, "lr_key");

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].name).toBe("lunaroute");
    expect(setCalls[0].config).toEqual({
      type: "remote",
      url: "https://mcp.example/mcp",
      headers: {
        "LUNAROUTE-API-KEY": "lr_key",
        "lunaroute-agent": "opencode",
        "x-lunaroute-session": "sess-1",
        "lunaroute-session-id": "sess-1",
      },
      oauth: false,
      disabled: false,
    });
  });

  it("places nothing when logged out", async () => {
    const { ctx, setCalls } = makeCtx();
    await createLunarouteMcp(opts()).register(ctx, undefined);
    expect(setCalls).toHaveLength(0);
  });

  it("never overwrites a user-defined mcp.lunaroute entry", async () => {
    const d = opts();
    const { ctx, setCalls } = makeCtx([["lunaroute", { url: "https://custom.example/mcp" }]]);
    await createLunarouteMcp(d).register(ctx, "lr_key");

    expect(setCalls).toHaveLength(0);
    expect(d.log).toHaveBeenCalledWith("info", expect.stringContaining("user-defined mcp.lunaroute"));
  });

  it("defers to any other entry pointing at the hosted URL, once", async () => {
    const d = opts();
    const { ctx, setCalls, reload } = makeCtx([["my-lunaroute", { url: "https://mcp.example/mcp/" }]]);
    const mcp = createLunarouteMcp(d);
    await mcp.register(ctx, "lr_key1");
    await mcp.refresh(ctx, "lr_key2"); // replay: notice stays single-shot

    expect(setCalls).toHaveLength(0);
    const defers = (d.log as ReturnType<typeof vi.fn>).mock.calls.filter(([, m]) =>
      String(m).includes("deferring to it"),
    );
    expect(defers).toHaveLength(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("refresh replays the transform with the new key", async () => {
    const { ctx, setCalls, reload } = makeCtx();
    const mcp = createLunarouteMcp(opts());
    await mcp.register(ctx, "lr_old");
    await mcp.refresh(ctx, "lr_new");

    expect(reload).toHaveBeenCalledTimes(1);
    expect(setCalls.map((c) => c.config.headers["LUNAROUTE-API-KEY"])).toEqual(["lr_old", "lr_new"]);
  });
});

describe("normalizedUrlIdentity / buildMcpServer", () => {
  it("ignores trailing slashes and query strings, keeps scheme+host", () => {
    expect(normalizedUrlIdentity({ url: "https://mcp.example/mcp/" })).toBe("https://mcp.example/mcp");
    expect(normalizedUrlIdentity({ url: "https://MCP.example/mcp?x=1" })).toBe("https://mcp.example/mcp");
    expect(normalizedUrlIdentity({ url: "http://mcp.example/mcp" })).toBe("http://mcp.example/mcp");
    expect(normalizedUrlIdentity({ url: "not a url" })).toBeUndefined();
    expect(normalizedUrlIdentity({})).toBeUndefined();
  });

  it("builds a disabled:false remote server", () => {
    expect(buildMcpServer("k", "https://mcp.example/mcp", "s")).toMatchObject({
      type: "remote",
      url: "https://mcp.example/mcp",
      disabled: false,
      oauth: false,
    });
  });
});
