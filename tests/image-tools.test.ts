import { describe, it, expect, vi } from "vitest";
import type { ToolContext } from "@opencode-ai/plugin";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import {
  buildImageToolMap,
  defaultIo,
  extractModelEnum,
  fetchImageBytes,
  parseImageResultText,
  parseUploadResultText,
  readUntilLimit,
  resolveImageDir,
  saveImage,
  sniffImageMime,
  UPLOAD_MAX_BYTES,
  DOWNLOAD_MAX_BYTES,
  type ImageIo,
  type ImageToolMapDeps,
} from "../src/image-tools.js";
import type { FetchLike } from "../src/web-tools.js";

// ============================================================================
// Fakes
// ============================================================================

type JsonRpcBody = { jsonrpc: string; id: number; method: string; params?: unknown };
type RecordedCall = { url: string; headers: Record<string, string>; signal?: AbortSignal; body: JsonRpcBody };

const jsonResponse = (payload: unknown) => ({ ok: true, text: async () => JSON.stringify(payload) }) as unknown as Response;
const statusResponse = (status: number) => ({ ok: false, status, text: async () => "" }) as unknown as Response;

interface FakeMcpRoutes {
  tools?: { name: string; inputSchema?: unknown }[];
  callResult?: (args: Record<string, unknown>) => { content: { type: string; text?: string; data?: string }[]; isError?: boolean };
  failToolsList?: boolean;
  /** cdn.example responses: bytes to stream, or a failure when omitted with failDownload. */
  downloadBytes?: Uint8Array;
  failDownload?: boolean;
}

function fakeMcp(routes: FakeMcpRoutes = {}) {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (String(url).startsWith("https://cdn.example/")) {
      if (routes.failDownload) return statusResponse(500);
      const bytes = routes.downloadBytes ?? PNG;
      let i = 0;
      const chunks = [bytes.subarray(0, 4), bytes.subarray(4)];
      return {
        ok: true,
        headers: { get: () => null },
        body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }) },
      } as unknown as Response;
    }
    const body = JSON.parse(String(init?.body)) as JsonRpcBody;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers, signal: init?.signal ?? undefined, body });
    if (body.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
    if (body.method === "tools/list") {
      if (routes.failToolsList) return statusResponse(503);
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: routes.tools ?? [] } });
    }
    if (body.method === "tools/call") {
      const args = (body.params as { arguments: Record<string, unknown> }).arguments;
      const result = routes.callResult?.(args) ?? { content: [] };
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result });
    }
    return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
  };
  return { fetchImpl, calls };
}

const makeIo = (): ImageIo & {
  writes: { path: string; data: Uint8Array; mode?: number }[];
  renames: [string, string][];
  rms: string[];
  bounded: Map<string, Uint8Array>;
  chmods: { path: string; mode: number }[];
} => {
  const writes: { path: string; data: Uint8Array; mode?: number }[] = [];
  const renames: [string, string][] = [];
  const rms: string[] = [];
  const bounded = new Map<string, Uint8Array>();
  const chmods: { path: string; mode: number }[] = [];
  return {
    writes,
    renames,
    rms,
    bounded,
    chmods,
    mkdir: async () => {},
    writeFile: async (path, data, options) => {
      writes.push({ path, data: data, mode: options?.mode });
    },
    chmod: async (path, mode) => {
      chmods.push({ path, mode });
    },
    link: async () => {},
    rename: async (from, to) => {
      renames.push([from, to]);
    },
    rm: async (path) => {
      rms.push(path);
    },
    readFileBounded: async (path) => {
      const data = bounded.get(path);
      if (!data) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return data;
    },
  };
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]);

const ctx = (signal?: AbortSignal): ToolContext =>
  ({ abort: signal ?? new AbortController().signal }) as unknown as ToolContext;

const valid = (key: string) => ({ state: "valid", key }) as const;

const makeDeps = (
  fetchImpl: FetchLike,
  over: Partial<ImageToolMapDeps> = {},
): ImageToolMapDeps => ({
  env: { LUNAROUTE_IMAGE_DIR: "/tmp/lr-test-images" },
  home: "/fake/home",
  mcpUrl: "http://mcp",
  sessionId: "sess-1",
  fetchImpl,
  resolveKey: async () => valid("lr_good"),
  readSettingsNow: () => ({ ...DEFAULT_SETTINGS }),
  ...over,
});

const callBodies = (calls: RecordedCall[], method: string) => calls.filter((c) => c.body.method === method);
const argsOf = (calls: RecordedCall[]) =>
  callBodies(calls, "tools/call").map((c) => (c.body.params as { arguments: Record<string, unknown> }).arguments);

// Server result text shapes (pi-verified contract)
const generateText = (id: string, extra = "") =>
  `Generated 1024x1024 png with flux2-klein (seed 42, 4 steps)\nid: ${id}\nurl: https://cdn.example/img.png (link expires in 1h)\nimage expires: in 24h${extra}`;
const uploadedText = (id: string) => `uploaded ${id} (512x512 png, 0.4 MiB)\nurl: https://cdn.example/u.png (link expires in 1h)`;

// ============================================================================
// Pure helpers
// ============================================================================

describe("parseImageResultText", () => {
  it("parses the line-based contract incl. seed/steps/from/url/expiry", () => {
    const r = parseImageResultText(generateText("img_1", "\nfrom: img_0, img_2"));
    expect(r).toMatchObject({ verb: "Generated", width: 1024, height: 1024, format: "png", model: "flux2-klein", seed: 42, steps: 4, id: "img_1" });
    expect(r.from).toEqual(["img_0", "img_2"]);
    expect(r.url).toBe("https://cdn.example/img.png");
    expect(r.urlExpires).toBe("in 1h");
    expect(r.imageExpires).toBe("in 24h");
  });
  it("Edited into head; unavailable url is dropped", () => {
    const r = parseImageResultText(`Edited into 512x512 webp with m (seed 1, 2 steps)\nid: img_9\nurl: (temporarily unavailable — retry)`);
    expect(r.verb).toBe("Edited into");
    expect(r.url).toBeUndefined();
  });
  it("non-matching text → rawText passthrough", () => {
    const r = parseImageResultText("boom");
    expect(r.rawText).toBe("boom");
    expect(r.id).toBe("");
  });
});

describe("parseUploadResultText", () => {
  it("parses the upload head + url", () => {
    const r = parseUploadResultText(uploadedText("img_7"));
    expect(r).toMatchObject({ id: "img_7", width: 512, height: 512, format: "png", mib: 0.4 });
    expect(r.url).toBe("https://cdn.example/u.png");
  });
  it("non-matching → rawText", () => {
    expect(parseUploadResultText("nope").rawText).toBe("nope");
  });
});

describe("sniffImageMime", () => {
  it("PNG/JPEG/WebP magic bytes → declared mime; garbage → undefined", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
    expect(sniffImageMime(new Uint8Array([0x00, 0x01]))).toBeUndefined();
    expect(sniffImageMime(new TextEncoder().encode("LUNAROUTE_API_KEY=lr_supersecret"))).toBeUndefined();
  });
});

describe("extractModelEnum", () => {
  const schema = (model: unknown) => ({ properties: { model } });
  it("extracts a string enum + description", () => {
    expect(extractModelEnum(schema({ enum: ["a", "b"], description: "limits" }))).toEqual({ enum: ["a", "b"], description: "limits" });
  });
  it("rejects empty/non-string enums and missing model", () => {
    expect(extractModelEnum(schema({ enum: [] }))).toBeUndefined();
    expect(extractModelEnum(schema({ enum: ["a", 5] }))).toBeUndefined();
    expect(extractModelEnum(schema(undefined))).toBeUndefined();
    expect(extractModelEnum({})).toBeUndefined();
    expect(extractModelEnum(null)).toBeUndefined();
  });
});

describe("readUntilLimit", () => {
  it("loops over short reads until EOF, capped at maxBytes", async () => {
    const full = new Uint8Array([1, 2, 3, 4, 5]);
    let pos = 0;
    const data = await readUntilLimit(async (buffer, offset, length, position) => {
      expect(position).toBe(pos);
      const n = Math.min(2, full.length - position, length);
      buffer.set(full.subarray(position, position + n), offset);
      pos += n;
      return n;
    }, 10);
    expect([...data]).toEqual([1, 2, 3, 4, 5]);
  });
  it("stops at the cap even when the file continues", async () => {
    let calls = 0;
    const data = await readUntilLimit(async (buffer, offset, length, position) => {
      calls++;
      buffer.fill(7, offset, offset + length);
      return length; // always "full"
    }, 4);
    expect(data.byteLength).toBe(4);
    expect(calls).toBe(1);
  });
});

describe("fetchImageBytes", () => {
  const bodyResponse = (chunks: Uint8Array[], headers?: Record<string, string>) => {
    let i = 0;
    const cancelled = { value: false };
    const reader = {
      read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
      cancel: async () => {
        cancelled.value = true;
      },
    };
    return {
      res: { ok: true, headers: { get: (n: string) => headers?.[n] ?? null }, body: { getReader: () => reader } } as unknown as Response,
      cancelled,
    };
  };
  it("collects streamed bytes under the cap", async () => {
    const { res } = bodyResponse([new Uint8Array([1, 2]), new Uint8Array([3])]);
    await expect(fetchImageBytes("https://x", async () => res)).resolves.toMatchObject({ 0: 1, 2: 3 });
  });
  it("content-length over the cap → undefined (no read)", async () => {
    const { res } = bodyResponse([new Uint8Array([1])], { "content-length": String(DOWNLOAD_MAX_BYTES + 1) });
    await expect(fetchImageBytes("https://x", async () => res)).resolves.toBeUndefined();
  });
  it("stream over the cap → undefined + reader cancelled", async () => {
    const big = new Uint8Array(DOWNLOAD_MAX_BYTES + 1);
    const { res, cancelled } = bodyResponse([big]);
    await expect(fetchImageBytes("https://x", async () => res)).resolves.toBeUndefined();
    expect(cancelled.value).toBe(true);
  });
  it("non-ok → undefined; null body → undefined", async () => {
    await expect(fetchImageBytes("https://x", async () => statusResponse(404))).resolves.toBeUndefined();
    await expect(fetchImageBytes("https://x", async () => ({ ok: true, headers: { get: () => null }, body: null }) as unknown as Response)).resolves.toBeUndefined();
  });
});

describe("resolveImageDir", () => {
  it("LUNAROUTE_IMAGE_DIR wins; default is the XDG-data opencode anchor", () => {
    expect(resolveImageDir({ LUNAROUTE_IMAGE_DIR: "/custom" }, "/h")).toBe("/custom");
    expect(resolveImageDir({}, "/h")).toBe("/h/.local/share/opencode/lunaroute-images");
    expect(resolveImageDir({ XDG_DATA_HOME: "/xdg" }, "/h")).toBe("/xdg/opencode/lunaroute-images");
  });
});

describe("saveImage permissions (real fs)", () => {
  it("dir 0700, file 0600; a pre-existing 0755 dir is hardened on save", async () => {
    const base = mkdtempSync(join(tmpdir(), "lr-img-perm-"));
    try {
      const dir = join(base, "images");
      mkdirSync(dir, { recursive: true, mode: 0o755 }); // old-install shape
      const path = await saveImage(dir, "img_perm", "png", PNG, defaultIo, undefined, true);
      expect(path).toBeDefined();
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(path as string).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  it("override dir (LUNAROUTE_IMAGE_DIR): mode respected, file still 0600", async () => {
    const base = mkdtempSync(join(tmpdir(), "lr-img-perm-"));
    try {
      const dir = join(base, "shared");
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      const path = await saveImage(dir, "img_shared", "png", PNG, defaultIo, undefined, false);
      expect(path).toBeDefined();
      expect(statSync(dir).mode & 0o777).toBe(0o755); // user-managed: untouched
      expect(statSync(path as string).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Registration gate
// ============================================================================

const imageSchema = (enumValues?: string[]) => ({
  type: "object",
  properties: {
    prompt: { type: "string" },
    ...(enumValues ? { model: { enum: enumValues, description: "per-org models" } } : { model: { type: "string" } }),
  },
});

const allThree = (modelEnum?: string[]) => [
  { name: "generate_image", inputSchema: imageSchema(modelEnum) },
  { name: "edit_image", inputSchema: imageSchema(modelEnum) },
  { name: "upload_image", inputSchema: imageSchema() },
];

describe("buildImageToolMap", () => {
  it("settings off (env) → no key resolution, no probe", async () => {
    const { fetchImpl, calls } = fakeMcp({ tools: allThree() });
    const resolveKey = vi.fn(async () => valid("lr_good"));
    const map = await buildImageToolMap(makeDeps(fetchImpl, { env: { LUNAROUTE_IMAGE_TOOLS: "off" }, resolveKey }));
    expect(map).toEqual({});
    expect(resolveKey).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("logged out / indeterminate → no tools, no probe", async () => {
    const { fetchImpl, calls } = fakeMcp({ tools: allThree() });
    expect(await buildImageToolMap(makeDeps(fetchImpl, { resolveKey: async () => ({ state: "logged-out" }) }))).toEqual({});
    expect(await buildImageToolMap(makeDeps(fetchImpl, { resolveKey: async () => ({ state: "indeterminate", reason: "x" }) }))).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("settings off (file) → no tools", async () => {
    const { fetchImpl } = fakeMcp({ tools: allThree() });
    const map = await buildImageToolMap(makeDeps(fetchImpl, { readSettingsNow: () => ({ ...DEFAULT_SETTINGS, imageTools: "off" }) }));
    expect(map).toEqual({});
  });

  it("probe failure (own probe path) → no tools + one warn", async () => {
    const { fetchImpl } = fakeMcp({ failToolsList: true });
    const logs: { level: string; message: string }[] = [];
    const map = await buildImageToolMap(makeDeps(fetchImpl, { log: (l, m) => logs.push({ level: l, message: m }) }));
    expect(map).toEqual({});
    expect(logs.some((l) => l.level === "warn" && /image tools not registered/.test(l.message))).toBe(true);
  });

  it("dir hardening: plugin-owned default → chmod on save; explicit override → left alone", async () => {
    const inlinePng = () => ({
      content: [
        { type: "text", text: generateText("img_h") },
        { type: "image", data: Buffer.from(PNG).toString("base64") },
      ],
    });
    const a = fakeMcp({ tools: allThree(["m1"]), callResult: inlinePng });
    const ioA = makeIo();
    const mapA = await buildImageToolMap(makeDeps(a.fetchImpl, { env: {}, io: ioA, descriptors: allThree(["m1"]) }));
    await mapA.generate_image.execute({ prompt: "x", model: "m1" }, ctx());
    expect(ioA.chmods).toEqual([{ path: "/fake/home/.local/share/opencode/lunaroute-images", mode: 0o700 }]);

    const b = fakeMcp({ tools: allThree(["m1"]), callResult: inlinePng });
    const ioB = makeIo();
    const mapB = await buildImageToolMap(makeDeps(b.fetchImpl, { io: ioB, descriptors: allThree(["m1"]) }));
    await mapB.generate_image.execute({ prompt: "x", model: "m1" }, ctx());
    expect(ioB.chmods).toEqual([]); // LUNAROUTE_IMAGE_DIR override is user-managed
  });

  it("server without the image tools → nothing registered", async () => {
    const { fetchImpl } = fakeMcp({ tools: [{ name: "generate_image" }].slice(0, 0) }); // empty tools/list
    expect(await buildImageToolMap(makeDeps(fetchImpl))).toEqual({});
  });

  it("server offering all three → all registered; pre-fetched descriptors skip the probe", async () => {
    const { fetchImpl, calls } = fakeMcp({});
    const map = await buildImageToolMap(makeDeps(fetchImpl, { descriptors: allThree(["m1", "m2"]) }));
    expect(Object.keys(map).sort()).toEqual(["edit_image", "generate_image", "upload_image"]);
    expect(calls).toHaveLength(0); // descriptors provided → no initialize/tools-list traffic
    // enum baking: the model arg is a zod enum over the server's per-org values
    const model = (map.generate_image.args as unknown as { model: { safeParse(v: string): { success: boolean } } }).model;
    expect(model.safeParse("m1").success).toBe(true);
    expect(model.safeParse("not-in-enum").success).toBe(false);
  });

  it("server offering only some → only those register", async () => {
    const { fetchImpl } = fakeMcp({ tools: [{ name: "upload_image", inputSchema: imageSchema() }] });
    const map = await buildImageToolMap(makeDeps(fetchImpl));
    expect(Object.keys(map)).toEqual(["upload_image"]);
  });
});

// ============================================================================
// generate_image / edit_image execute
// ============================================================================

describe("image tool executes", () => {
  const build = async (routes: FakeMcpRoutes, over: Partial<ImageToolMapDeps> = {}) => {
    const server = fakeMcp(routes);
    const deps = makeDeps(server.fetchImpl, { descriptors: allThree(["m1"]), io: makeIo(), ...over });
    const map = await buildImageToolMap(deps);
    return { map, server, io: deps.io as ImageIo & { writes: { path: string; data: Uint8Array }[]; renames: [string, string][]; rms: string[] } };
  };

  const inlineImageCall = (id: string) => ({
    content: [
      { type: "text", text: generateText(id) },
      { type: "image", data: Buffer.from(PNG).toString("base64") },
    ],
  });

  it("generate: hits the MCP with embed:true, lr_ key + attribution; inline bytes → saved + file:// attachment", async () => {
    const { map, server, io } = await build({ tools: allThree(["m1"]), callResult: () => inlineImageCall("img_abc") });
    const result = await map.generate_image.execute({ prompt: "a cat", model: "m1" }, ctx());
    const calls = callBodies(server.calls, "tools/call");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.params).toEqual({ name: "generate_image", arguments: { prompt: "a cat", model: "m1", embed: true } });
    expect(calls[0].headers["LUNAROUTE-API-KEY"]).toBe("lr_good");
    expect(calls[0].headers["lunaroute-agent"]).toBe("opencode");
    expect(calls[0].headers["x-lunaroute-session"]).toBe("sess-1");
    // temp-then-rename save of the inline bytes
    expect(io.writes[0].path).toMatch(/img_abc\.png\.[0-9a-f-]+\.tmp$/);
    expect(io.renames).toEqual([[io.writes[0].path, "/tmp/lr-test-images/img_abc.png"]]);
    const out = typeof result === "string" ? result : result.output;
    expect(out).toContain("saved to: /tmp/lr-test-images/img_abc.png");
    const att = (typeof result === "string" ? undefined : result.attachments)?.[0];
    expect(att).toMatchObject({ type: "file", mime: "image/png", url: "file:///tmp/lr-test-images/img_abc.png", filename: "img_abc.png" });
  });

  it("generate: no inline bytes → downloads the signed url and saves it", async () => {
    const { map, io } = await build(
      { tools: allThree(["m1"]), callResult: () => ({ content: [{ type: "text", text: generateText("img_dl") }] }), downloadBytes: PNG },
    );
    const result = await map.generate_image.execute({ prompt: "x", model: "m1" }, ctx());
    expect(io.renames).toHaveLength(1);
    expect(io.renames[0][1]).toBe("/tmp/lr-test-images/img_dl.png");
    const att = (typeof result === "string" ? undefined : result.attachments)?.[0];
    expect(att?.url).toBe("file:///tmp/lr-test-images/img_dl.png");
  });

  it("generate: download failure → not-saved note, no attachment, id+url still go out", async () => {
    const { map, io } = await build(
      { tools: allThree(["m1"]), callResult: () => ({ content: [{ type: "text", text: generateText("img_f") }] }), failDownload: true },
    );
    const result = await map.generate_image.execute({ prompt: "x", model: "m1" }, ctx());
    expect(io.writes).toHaveLength(0);
    const out = typeof result === "string" ? result : result.output;
    expect(out).toContain("not saved locally — fetch the url before it expires");
    expect(out).toContain("https://cdn.example/img.png");
    expect(typeof result === "string" ? undefined : result.attachments).toBeUndefined();
  });

  it("generate: server id that is not img_-shaped never reaches the filesystem", async () => {
    const { map, io } = await build({ tools: allThree(["m1"]), callResult: () => inlineImageCall("../evil") });
    const result = await map.generate_image.execute({ prompt: "x", model: "m1" }, ctx());
    expect(io.writes).toHaveLength(0);
    const out = typeof result === "string" ? result : result.output;
    expect(out).toContain("not saved locally");
  });

  it("generate: isError → throws with the server text", async () => {
    const { map } = await build({
      tools: allThree(["m1"]),
      callResult: () => ({ content: [{ type: "text", text: "model not entitled" }], isError: true }),
    });
    await expect(map.generate_image.execute({ prompt: "x", model: "m1" }, ctx())).rejects.toThrow("model not entitled");
  });

  it("edit: image_ids on the wire; from ids in metadata", async () => {
    const { map, server } = await build({
      tools: allThree(["m1"]),
      callResult: () => ({ content: [{ type: "text", text: generateText("img_e2", "\nfrom: img_e1") }] }),
    });
    const result = await map.edit_image.execute({ prompt: "make it red", model: "m1", image_ids: ["img_e1"] }, ctx());
    expect(argsOf(server.calls)[0]).toEqual({ prompt: "make it red", model: "m1", image_ids: ["img_e1"], embed: true });
    const meta = (typeof result === "string" ? {} : result.metadata) as { from?: string[] };
    expect(meta.from).toEqual(["img_e1"]);
  });

  it("rotation: the next call carries the fresh key (lazy per-execute read)", async () => {
    const keys = ["lr_a", "lr_a", "lr_b"]; // gate probe, execute 1, execute 2
    let i = 0;
    const { map, server } = await build(
      { tools: allThree(["m1"]), callResult: () => inlineImageCall("img_r") },
      { resolveKey: async () => valid(keys[Math.min(i++, keys.length - 1)]) },
    );
    await map.generate_image.execute({ prompt: "1", model: "m1" }, ctx());
    await map.generate_image.execute({ prompt: "2", model: "m1" }, ctx());
    const calls = callBodies(server.calls, "tools/call");
    expect(calls[0].headers["LUNAROUTE-API-KEY"]).toBe("lr_a");
    expect(calls[1].headers["LUNAROUTE-API-KEY"]).toBe("lr_b");
  });

  it("mid-session logout → clean /connect error", async () => {
    let resolution: { state: "valid"; key: string } | { state: "logged-out" } = valid("lr_good");
    const { map } = await build(
      { tools: allThree(["m1"]), callResult: () => inlineImageCall("img_x") },
      { resolveKey: async () => resolution },
    );
    resolution = { state: "logged-out" };
    await expect(map.generate_image.execute({ prompt: "x", model: "m1" }, ctx())).rejects.toThrow(/\/connect/);
  });
});

// ============================================================================
// upload_image execute
// ============================================================================

describe("upload_image execute", () => {
  const buildUpload = async (routes: FakeMcpRoutes, over: Partial<ImageToolMapDeps> = {}) => {
    const server = fakeMcp(routes);
    const io = makeIo();
    const deps = makeDeps(server.fetchImpl, { descriptors: allThree(["m1"]), io, ...over });
    const map = await buildImageToolMap(deps);
    return { map, server, io };
  };

  it("path: magic bytes sniffed BEFORE upload; declared mime + base64 on the wire", async () => {
    const { map, server, io } = await buildUpload({
      tools: allThree(["m1"]),
      callResult: () => ({ content: [{ type: "text", text: uploadedText("img_u1") }] }),
    });
    io.bounded.set("/tmp/pic.png", PNG);
    await map.upload_image.execute({ path: "/tmp/pic.png" }, ctx());
    const sent = argsOf(server.calls)[0];
    expect(sent.mime_type).toBe("image/png");
    expect(sent.data).toBe(Buffer.from(PNG).toString("base64"));
    expect(sent.url).toBeUndefined();
  });

  it("credential-shaped / non-image path is refused locally — nothing leaves the machine", async () => {
    const { map, server, io } = await buildUpload({ tools: allThree(["m1"]) });
    io.bounded.set("/tmp/creds", new TextEncoder().encode("LUNAROUTE_API_KEY=lr_supersecret"));
    await expect(map.upload_image.execute({ path: "/tmp/creds" }, ctx())).rejects.toThrow(/not a png, jpeg, or webp/);
    expect(callBodies(server.calls, "tools/call")).toHaveLength(0);
  });

  it("over-ceiling file rejected on the bytes actually read (TOCTOU-safe)", async () => {
    const { map, server, io } = await buildUpload({ tools: allThree(["m1"]) });
    // Pretend the bounded read returned ceiling+1 bytes (a file swapped for a
    // huge one between checks must fail here, not inflate into JSON-RPC).
    io.bounded.set("/tmp/huge", new Uint8Array(UPLOAD_MAX_BYTES + 1));
    await expect(map.upload_image.execute({ path: "/tmp/huge" }, ctx())).rejects.toThrow(/11 MiB/);
    expect(callBodies(server.calls, "tools/call")).toHaveLength(0);
  });

  it("url: http(s) only; both/neither → error", async () => {
    const { map, server } = await buildUpload({
      tools: allThree(["m1"]),
      callResult: () => ({ content: [{ type: "text", text: uploadedText("img_u2") }] }),
    });
    await expect(map.upload_image.execute({ url: "ftp://x/y" }, ctx())).rejects.toThrow(/http\(s\)/);
    await expect(map.upload_image.execute({ path: "/a", url: "https://x" }, ctx())).rejects.toThrow(/exactly one/);
    await expect(map.upload_image.execute({}, ctx())).rejects.toThrow(/exactly one/);
    await map.upload_image.execute({ url: "https://x/y.png" }, ctx());
    expect(argsOf(server.calls)[0]).toEqual({ url: "https://x/y.png" });
  });

  it("isError → throws (no edit hint on failure)", async () => {
    const { map } = await buildUpload({
      tools: allThree(["m1"]),
      callResult: () => ({ content: [{ type: "text", text: "too large" }], isError: true }),
    });
    await expect(map.upload_image.execute({ url: "https://x/y.png" }, ctx())).rejects.toThrow("too large");
  });
});
