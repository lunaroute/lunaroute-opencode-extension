import { describe, it, expect, vi } from "vitest";
import type { ToolContext } from "@opencode-ai/plugin";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import {
  buildConvertTool,
  buildConvertToolMap,
  CONVERT_MAX_INPUT_BYTES,
  parseArtifactUrl,
  resolveDocsDir,
  saveDocument,
  sniffDocumentFormat,
  type ConvertToolMapDeps,
} from "../src/convert-tools.js";
import type { ToolResult } from "@opencode-ai/plugin";
import type { FetchLike, McpToolCallResult } from "../src/web-tools.js";
import { defaultIo, type ImageIo } from "../src/image-tools.js";

// ============================================================================
// Fakes
// ============================================================================

type JsonRpcBody = { jsonrpc: string; id: number; method: string; params?: unknown };
type RecordedCall = { url: string; headers: Record<string, string>; signal?: AbortSignal; body: JsonRpcBody };

const jsonResponse = (payload: unknown) => ({ ok: true, text: async () => JSON.stringify(payload) }) as unknown as Response;
const statusResponse = (status: number) => ({ ok: false, status, text: async () => "" }) as unknown as Response;

interface FakeMcpRoutes {
  tools?: { name: string; inputSchema?: unknown }[];
  callResult?: (args: Record<string, unknown>) => { content: { type: string; text?: string }[]; isError?: boolean };
  failToolsList?: boolean;
  /** cdn.example responses: markdown bytes to stream, or a failure. */
  downloadBytes?: Uint8Array;
  failDownload?: boolean;
}

function fakeMcp(routes: FakeMcpRoutes = {}) {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (String(url).startsWith("https://cdn.example/")) {
      if (routes.failDownload) return statusResponse(500);
      const bytes = routes.downloadBytes ?? new TextEncoder().encode("# Document\n\ncontent");
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

const ctx = (signal?: AbortSignal): ToolContext =>
  ({ abort: signal ?? new AbortController().signal }) as unknown as ToolContext;
const valid = (key: string) => ({ state: "valid", key }) as const;

const makeIo = (): ImageIo & {
  writes: { path: string; data: Uint8Array; mode?: number }[];
  renames: [string, string][];
  rms: string[];
  chmods: { path: string; mode: number }[];
  files: Map<string, Uint8Array>;
} => {
  const writes: { path: string; data: Uint8Array; mode?: number }[] = [];
  const renames: [string, string][] = [];
  const rms: string[] = [];
  const chmods: { path: string; mode: number }[] = [];
  const files = new Map<string, Uint8Array>();
  return {
    writes,
    renames,
    rms,
    chmods,
    files,
    mkdir: async () => {},
    writeFile: async (path, data, options) => {
      writes.push({ path, data, mode: options?.mode });
      files.set(path, data);
    },
    chmod: async (path, mode) => {
      chmods.push({ path, mode });
    },
    link: async (from, to) => {
      if (files.has(to)) {
        throw Object.assign(new Error("file exists"), { code: "EEXIST" });
      }
      const data = files.get(from);
      if (data) files.set(to, data);
    },
    rename: async (from, to) => {
      renames.push([from, to]);
      const data = files.get(from);
      files.delete(from);
      if (data) files.set(to, data);
    },
    rm: async (path) => {
      rms.push(path);
      files.delete(path);
    },
    readFileBounded: async (path, maxBytes) => {
      const data = files.get(path);
      if (!data) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return data.byteLength > maxBytes ? data.subarray(0, maxBytes) : data;
    },
  };
};

const makeDeps = (fetchImpl: FetchLike, over: Partial<ConvertToolMapDeps> = {}): ConvertToolMapDeps => ({
  env: { LUNAROUTE_DOCS_DIR: "/tmp/lr-test-docs" },
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
const outputOf = (r: ToolResult): string => (typeof r === "string" ? r : r.output);

/** Build a real ZIP (stored entries, central directory + EOCD) so the
 * format guard's parser exercises actual structures, not byte scans. */
function buildZip(entries: { name: string; content: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const content = enc.encode(e.content);
    const local = new Uint8Array(30 + name.length + content.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint32(18, content.length, true);
    lv.setUint32(22, content.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(content, 30 + name.length);
    parts.push(local);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(20, content.length, true);
    cv.setUint32(24, content.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...centrals, eocd];
  const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
const DOCX = buildZip([
  { name: "[Content_Types].xml", content: "<Types/>" },
  { name: "word/document.xml", content: "<w/>" },
]);
const ODT = buildZip([
  { name: "mimetype", content: "application/vnd.oasis.opendocument.text" },
  { name: "content.xml", content: "<x/>" },
]);
const EPUB = buildZip([{ name: "mimetype", content: "application/epub+zip" }]);
const PADDED = buildZip([{ name: "notes.txt", content: "[Content_Types].xml word/ opendocument epub+zip" }]); // marker strings in data only
const PLAIN_ZIP = buildZip([{ name: "backups/2024.tar", content: "tar-ish" }]);
const WRONG_MIMETYPE = buildZip([{ name: "mimetype", content: "text/plain" }]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1]);
const RTF = new Uint8Array([0x7b, 0x5c, 0x72, 0x74, 0x66, 1]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const CSV = new TextEncoder().encode("a,b\n1,2\n");
const NOT_UTF8 = new Uint8Array([0xff, 0xfe, 0x00, 0xff, 0x00]);

// ============================================================================
// Pure helpers
// ============================================================================

describe("sniffDocumentFormat", () => {
  it("binary magics: zip/pdf/rtf/image families", () => {
    expect(sniffDocumentFormat(DOCX)).toEqual({ kind: "binary", format: "zip" });
    expect(sniffDocumentFormat(ODT)).toEqual({ kind: "binary", format: "zip" });
    expect(sniffDocumentFormat(EPUB)).toEqual({ kind: "binary", format: "zip" });
    // Bypass attempts (roborev follow-up): marker strings in file DATA or
    // unrelated names must not smuggle an arbitrary archive through.
    expect(sniffDocumentFormat(PADDED)).toBeUndefined();
    expect(sniffDocumentFormat(PLAIN_ZIP)).toBeUndefined();
    expect(sniffDocumentFormat(WRONG_MIMETYPE)).toBeUndefined(); // mimetype entry must carry the exact magic
    expect(sniffDocumentFormat(DOCX.subarray(0, DOCX.length - 30))).toBeUndefined(); // malformed → fail closed
    expect(sniffDocumentFormat(PDF)).toEqual({ kind: "binary", format: "pdf" });
    expect(sniffDocumentFormat(RTF)).toEqual({ kind: "binary", format: "rtf" });
    expect(sniffDocumentFormat(PNG)).toEqual({ kind: "binary", format: "image", mime: "image/png" });
  });
  it("valid UTF-8 → text; non-UTF-8 and empty → undefined (reject)", () => {
    expect(sniffDocumentFormat(CSV)).toEqual({ kind: "text" });
    expect(sniffDocumentFormat(NOT_UTF8)).toBeUndefined();
    expect(sniffDocumentFormat(new Uint8Array(0))).toBeUndefined();
  });
});

describe("parseArtifactUrl", () => {
  it("parses url + expiry; unavailable or absent → undefined", () => {
    expect(parseArtifactUrl("url: https://cdn/x.md (link expires in 7d)")).toEqual({
      url: "https://cdn/x.md",
      expiresAt: "in 7d",
    });
    expect(parseArtifactUrl("url: (temporarily unavailable — retry)")).toBeUndefined();
    expect(parseArtifactUrl("no url line")).toBeUndefined();
  });
});

describe("resolveDocsDir", () => {
  it("override wins; default is the XDG-data opencode anchor", () => {
    expect(resolveDocsDir({ LUNAROUTE_DOCS_DIR: "/custom" }, "/h")).toBe("/custom");
    expect(resolveDocsDir({}, "/h")).toBe("/h/.local/share/opencode/lunaroute-docs");
  });
});

describe("saveDocument", () => {
  const bytes = new TextEncoder().encode("# Document");

  it("identical content keeps the same path (idempotent re-conversion)", async () => {
    const state = makeIo();
    const io = state;
    const first = await saveDocument("/docs", "report", bytes, io);
    const again = await saveDocument("/docs", "report", bytes, io);
    expect(first).toBe("/docs/report.md");
    expect(again).toBe("/docs/report.md");
    expect(state.files.has("/docs/report.md")).toBe(true);
  });
  it("different content at the target → unique suffix", async () => {
    const io = makeIo();
    await saveDocument("/docs", "report", bytes, io);
    const second = await saveDocument("/docs", "report", new TextEncoder().encode("# Other"), io);
    expect(second).toMatch(/^\/docs\/report-[0-9a-f]{6}\.md$/);
  });
  it("publish failure removes only the temp file; success cleans the tmp, never the target", async () => {
    const state = makeIo();
    const io = state;
    state.link = async () => {
      throw new Error("disk full");
    };
    expect(await saveDocument("/docs", "r", bytes, io)).toBeUndefined();
    expect(state.rms).toHaveLength(1); // the tmp only
    const state2 = makeIo();
    const io2 = state2;
    const path = await saveDocument("/docs", "r", bytes, io2);
    expect(path).toBe("/docs/r.md");
    expect(state2.rms).toHaveLength(1); // tmp cleanup after the atomic publish
    expect(state2.files.has("/docs/r.md")).toBe(true); // the target is never deleted
    expect(state2.renames).toHaveLength(0); // publish is link-based, not rename-based
  });
  it("private by default: tmp written 0600, dir hardened only when asked", async () => {
    const state = makeIo();
    const io = state;
    await saveDocument("/docs", "r", bytes, io, undefined, true);
    expect(state.writes[0].mode).toBe(0o600);
    expect(state.chmods).toEqual([{ path: "/docs", mode: 0o700 }]);
    const state2 = makeIo();
    const io2 = state2;
    await saveDocument("/docs", "r", bytes, io2); // override dir: no chmod
    expect(state2.chmods).toEqual([]);
    expect(state2.writes[0].mode).toBe(0o600);
  });
  it("real fs: dir 0700 / file 0600 when hardened; override respected", async () => {
    const base = mkdtempSync(join(tmpdir(), "lr-doc-perm-"));
    try {
      const dir = join(base, "docs");
      const p = await saveDocument(dir, "r", bytes, defaultIo, undefined, true);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(p as string).mode & 0o777).toBe(0o600);
      const dir2 = join(base, "shared");
      mkdirSync(dir2, { recursive: true, mode: 0o755 });
      const p2 = await saveDocument(dir2, "r", bytes, defaultIo, undefined, false);
      expect(statSync(dir2).mode & 0o777).toBe(0o755);
      expect(statSync(p2 as string).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Registration gate
// ============================================================================

describe("buildConvertToolMap", () => {
  it("settings off (env) → no key resolution, no probe", async () => {
    const { fetchImpl, calls } = fakeMcp({ tools: [{ name: "convert_document" }] });
    const resolveKey = vi.fn(async () => valid("lr_good"));
    const map = await buildConvertToolMap(makeDeps(fetchImpl, { env: { LUNAROUTE_CONVERT_TOOLS: "off" }, resolveKey }));
    expect(map).toEqual({});
    expect(resolveKey).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
  it("settings off (file) and logged out → absent, no probe", async () => {
    const { fetchImpl, calls } = fakeMcp({ tools: [{ name: "convert_document" }] });
    expect(
      await buildConvertToolMap(makeDeps(fetchImpl, { readSettingsNow: () => ({ ...DEFAULT_SETTINGS, convertTools: "off" }) })),
    ).toEqual({});
    expect(await buildConvertToolMap(makeDeps(fetchImpl, { resolveKey: async () => ({ state: "logged-out" }) }))).toEqual({});
    expect(calls).toHaveLength(0);
  });
  it("probe failure (own probe path) → warn + absent; server without the tool → absent", async () => {
    const logs: { level: string; message: string }[] = [];
    const fail = fakeMcp({ failToolsList: true });
    expect(
      await buildConvertToolMap(makeDeps(fail.fetchImpl, { log: (l, m) => logs.push({ level: l, message: m }) })),
    ).toEqual({});
    expect(logs.some((l) => l.level === "warn" && /convert tool not registered/.test(l.message))).toBe(true);
    const empty = fakeMcp({ tools: [] });
    expect(await buildConvertToolMap(makeDeps(empty.fetchImpl))).toEqual({});
  });
  it("server offering convert_document → registered; pre-fetched descriptors skip the probe", async () => {
    const { fetchImpl, calls } = fakeMcp({});
    const map = await buildConvertToolMap(makeDeps(fetchImpl, { descriptors: [{ name: "convert_document" }] }));
    expect(Object.keys(map)).toEqual(["convert_document"]);
    expect(calls).toHaveLength(0);
  });
});

// ============================================================================
// convert_document execute
// ============================================================================

describe("convert_document execute", () => {
  const build = async (routes: FakeMcpRoutes, over: Partial<ConvertToolMapDeps> = {}) => {
    const server = fakeMcp(routes);
    const io = makeIo();
    const deps = makeDeps(server.fetchImpl, { descriptors: [{ name: "convert_document" }], io, ...over });
    const map = await buildConvertToolMap(deps);
    return { map, server, io: deps.io as ReturnType<typeof makeIo> };
  };
  const artifactText = "url: https://cdn.example/doc.md (link expires in 7d)\nstored doc_abc";

  it("path: docx sniffed as zip → base64 + derived filename on the wire; full markdown back", async () => {
    const { map, server, io } = await build({
      tools: [{ name: "convert_document" }],
      callResult: () => ({ content: [{ type: "text", text: "# Converted\n\ntext" }] }),
    });
    void io;
    io.files.set("/tmp/report.docx", DOCX);
    const result = await map.convert_document.execute({ path: "/tmp/report.docx" }, ctx());
    const sent = argsOf(server.calls)[0];
    expect(sent.data).toBe(Buffer.from(DOCX).toString("base64"));
    expect(sent.filename).toBe("report.docx");
    expect(sent.embed).toBe(true);
    expect(sent.ocr).toBeUndefined();
    expect(outputOf(result)).toBe("# Converted\n\ntext");
  });

  it("ocr passthrough only when set", async () => {
    const { map, server, io } = await build({
      tools: [{ name: "convert_document" }],
      callResult: () => ({ content: [{ type: "text", text: "# o" }] }),
    });
    void io;
    io.files.set("/tmp/scan.pdf", PDF);
    await map.convert_document.execute({ path: "/tmp/scan.pdf", ocr: true }, ctx());
    expect(argsOf(server.calls)[0].ocr).toBe(true);
  });

  it("over-ceiling file rejected on the bytes actually read", async () => {
    const { map, server, io } = await build({ tools: [{ name: "convert_document" }] });
    io.files.set("/tmp/huge.docx", new Uint8Array(CONVERT_MAX_INPUT_BYTES + 1));
    await expect(map.convert_document.execute({ path: "/tmp/huge.docx" }, ctx())).rejects.toThrow(/10 MiB/);
    expect(callBodies(server.calls, "tools/call")).toHaveLength(0);
  });

  it("unrecognized format refused before any network call", async () => {
    const { map, server, io } = await build({ tools: [{ name: "convert_document" }] });
    io.files.set("/tmp/blob", NOT_UTF8);
    await expect(map.convert_document.execute({ path: "/tmp/blob" }, ctx())).rejects.toThrow(/not a recognized document/);
    expect(callBodies(server.calls, "tools/call")).toHaveLength(0);
  });

  it("text policy: .csv path uploads; extensionless + explicit .csv filename uploads", async () => {
    const { map, server, io } = await build({
      tools: [{ name: "convert_document" }],
      callResult: () => ({ content: [{ type: "text", text: "a,b" }] }),
    });
    io.files.set("/tmp/data.csv", CSV);
    await map.convert_document.execute({ path: "/tmp/data.csv" }, ctx());
    expect(argsOf(server.calls)[0].filename).toBe("data.csv");
    io.files.set("/tmp/extract", CSV);
    await map.convert_document.execute({ path: "/tmp/extract", filename: "report.csv" }, ctx());
    expect(argsOf(server.calls)[1].filename).toBe("report.csv");
  });

  it("text policy: plain text refused; dotfiles and Windows-laundered hidden paths refused", async () => {
    const { map, server, io } = await build({ tools: [{ name: "convert_document" }] });
    io.files.set("/tmp/notes.txt", new TextEncoder().encode("hello"));
    await expect(map.convert_document.execute({ path: "/tmp/notes.txt" }, ctx())).rejects.toThrow(/only .csv files are converted as text/);
    io.files.set("/home/u/.ssh/config", CSV);
    await expect(map.convert_document.execute({ path: "/home/u/.ssh/config", filename: "config.csv" }, ctx())).rejects.toThrow(/only .csv/);
    io.files.set("/home/u/.ssh/id_rsa", CSV);
    io.files.set("\\home\\u\\.ssh\\id_rsa", CSV); // the raw path is what the read opens
    await expect(map.convert_document.execute({ path: "\\home\\u\\.ssh\\id_rsa", filename: "report.csv" }, ctx())).rejects.toThrow(/only .csv/);
    expect(callBodies(server.calls, "tools/call")).toHaveLength(0);
  });

  it("text policy: ordinary relative paths (./data.csv) are not falsely hidden", async () => {
    const { map, server, io } = await build({
      tools: [{ name: "convert_document" }],
      callResult: () => ({ content: [{ type: "text", text: "a,b" }] }),
    });
    io.files.set("./data.csv", CSV);
    await map.convert_document.execute({ path: "./data.csv" }, ctx());
    expect(argsOf(server.calls)[0].filename).toBe("data.csv");
  });

  it("binary immunity: a png named notes.csv is sniffed, not trusted as text", async () => {
    const { map, server, io } = await build({
      tools: [{ name: "convert_document" }],
      callResult: () => ({ content: [{ type: "text", text: "# ocr'd" }] }),
    });
    io.files.set("/tmp/notes.csv", PNG);
    await map.convert_document.execute({ path: "/tmp/notes.csv", filename: "notes.csv" }, ctx());
    const sent = argsOf(server.calls)[0];
    expect(sent.data).toBe(Buffer.from(PNG).toString("base64"));
    expect(sent.filename).toBe("notes.csv");
  });

  it("url: http(s) only; both/neither → error", async () => {
    const { map, server } = await build({
      tools: [{ name: "convert_document" }],
      callResult: () => ({ content: [{ type: "text", text: "# from url" }] }),
    });
    await expect(map.convert_document.execute({ url: "ftp://x/d" }, ctx())).rejects.toThrow(/http\(s\)/);
    await expect(map.convert_document.execute({ path: "/a", url: "https://x/d" }, ctx())).rejects.toThrow(/exactly one/);
    await expect(map.convert_document.execute({}, ctx())).rejects.toThrow(/exactly one/);
    await map.convert_document.execute({ url: "https://x/d.pdf", filename: "d.pdf" }, ctx());
    expect(argsOf(server.calls)[0]).toEqual({ url: "https://x/d.pdf", filename: "d.pdf", embed: true });
  });

  it("output_too_large (thrown shape): exactly one embed:false fallback, artifact downloaded + saved", async () => {
    const { map, server, io } = await build({
      tools: [{ name: "convert_document" }],
      callResult: (args) =>
        args.embed === true
          ? { content: [{ type: "text", text: "output_too_large: try embed: false" }], isError: true }
          : { content: [{ type: "text", text: artifactText }] },
      downloadBytes: new TextEncoder().encode("# Full document\n\n" + "x".repeat(2000)),
    });
    const result = await map.convert_document.execute({ url: "https://example.com/d.docx" }, ctx());
    const calls = callBodies(server.calls, "tools/call");
    expect(calls).toHaveLength(2); // never a third call
    expect(argsOf(server.calls)[0].embed).toBe(true);
    expect(argsOf(server.calls)[1].embed).toBe(false);
    const out = outputOf(result);
    expect(out).toContain("full document saved to: /tmp/lr-test-docs/document.md");
    expect(out).toContain("# Full document");
    expect(io.files.has("/tmp/lr-test-docs/document.md")).toBe(true);
  });

  it("output_too_large (raw isError shape via a non-throwing callServer) routes to the same fallback", async () => {
    const calls: Record<string, unknown>[] = [];
    const callServer = async (_name: string, args: Record<string, unknown>): Promise<McpToolCallResult> => {
      calls.push(args);
      if (args.embed === true) return { content: [{ type: "text", text: "output_too_large" }], isError: true };
      return { content: [{ type: "text", text: artifactText }] };
    };
    const def = buildConvertTool({
      mcpToolName: "convert_document",
      callServer,
      docsDir: "/tmp/lr-test-docs",
      fetchImpl: async () => {
        throw new Error("no download"); // download failure → honest url note
      },
    });
    const result = await def.execute({ url: "https://example.com/d.docx" }, ctx());
    expect(calls).toHaveLength(2);
    expect(outputOf(result)).toContain("(the artifact could not be downloaded locally");
  });

  it("fallback without an artifact url → honest message, still exactly two calls", async () => {
    const { map, server } = await build({
      tools: [{ name: "convert_document" }],
      callResult: (args) =>
        args.embed === true
          ? { content: [{ type: "text", text: "output_too_large" }], isError: true }
          : { content: [{ type: "text", text: "no url here" }] },
    });
    const result = await map.convert_document.execute({ url: "https://example.com/d.docx" }, ctx());
    expect(callBodies(server.calls, "tools/call")).toHaveLength(2);
    expect(outputOf(result)).toContain("did not return an artifact url");
  });

  it("double failure (fallback also output_too_large) surfaces honestly — no third call", async () => {
    const { map, server } = await build({
      tools: [{ name: "convert_document" }],
      callResult: () => ({ content: [{ type: "text", text: "output_too_large: still too big" }], isError: true }),
    });
    await expect(map.convert_document.execute({ url: "https://example.com/d.docx" }, ctx())).rejects.toThrow(/still too big/);
    expect(callBodies(server.calls, "tools/call")).toHaveLength(2);
  });

  it("mid-session logout → clean /connect error", async () => {
    let resolution: { state: "valid"; key: string } | { state: "logged-out" } = valid("lr_good");
    const { map } = await build(
      { tools: [{ name: "convert_document" }], callResult: () => ({ content: [{ type: "text", text: "# x" }] }) },
      { resolveKey: async () => resolution },
    );
    resolution = { state: "logged-out" };
    await expect(map.convert_document.execute({ url: "https://x/d" }, ctx())).rejects.toThrow(/\/connect/);
  });

  it("docs dir: plugin-owned default hardened on fallback save; override untouched", async () => {
    const defaultEnv = fakeMcp({
      tools: [{ name: "convert_document" }],
      callResult: (args) =>
        args.embed === true
          ? { content: [{ type: "text", text: "output_too_large" }], isError: true }
          : { content: [{ type: "text", text: artifactText }] },
      downloadBytes: new TextEncoder().encode("# D"),
    });
    const ioA = makeIo();
    const mapA = await buildConvertToolMap(makeDeps(defaultEnv.fetchImpl, { env: {}, io: ioA, descriptors: [{ name: "convert_document" }] }));
    await mapA.convert_document.execute({ url: "https://example.com/d.docx" }, ctx());
    expect(ioA.chmods).toEqual([{ path: "/fake/home/.local/share/opencode/lunaroute-docs", mode: 0o700 }]);

    const override = fakeMcp({
      tools: [{ name: "convert_document" }],
      callResult: (args) =>
        args.embed === true
          ? { content: [{ type: "text", text: "output_too_large" }], isError: true }
          : { content: [{ type: "text", text: artifactText }] },
      downloadBytes: new TextEncoder().encode("# D"),
    });
    const ioB = makeIo();
    const mapB = await buildConvertToolMap(makeDeps(override.fetchImpl, { io: ioB, descriptors: [{ name: "convert_document" }] }));
    await mapB.convert_document.execute({ url: "https://example.com/d.docx" }, ctx());
    expect(ioB.chmods).toEqual([]); // LUNAROUTE_DOCS_DIR override is user-managed
  });
});

describe("symlink refusal (real fs — the path-trust boundary)", () => {
  it("a report.csv symlink to a private key is refused before any upload", async () => {
    const base = mkdtempSync(join(tmpdir(), "lr-symlink-"));
    try {
      const secret = join(base, "id_rsa");
      writeFileSync(secret, "-----BEGIN OPENSSH PRIVATE KEY-----\nnope\n-----END-----\n");
      const link = join(base, "report.csv");
      symlinkSync(secret, link);
      const server = fakeMcp({
        tools: [{ name: "convert_document" }],
        callResult: () => ({ content: [{ type: "text", text: "should never happen" }] }),
      });
      const map = await buildConvertToolMap(
        makeDeps(server.fetchImpl, { io: defaultIo, descriptors: [{ name: "convert_document" }] }),
      );
      await expect(map.convert_document.execute({ path: link }, ctx())).rejects.toThrow(/symbolic link/);
      expect(callBodies(server.calls, "tools/call")).toHaveLength(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
