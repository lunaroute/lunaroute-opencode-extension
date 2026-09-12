import { tool, type ToolDefinition, type ToolResult } from "@opencode-ai/plugin";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AuthResolution } from "./mcp.js";
import { buildAttributionHeaders } from "./lunaroute.js";
import { imageToolsEnabled, type LunarouteSettings } from "./settings.js";
import {
  createLunarouteMcpClient,
  listServerToolDescriptors,
  WEB_TOOLS_PROBE_TIMEOUT_MS,
  type FetchLike,
  type McpToolCallResult,
} from "./web-tools.js";

/**
 * First-class image tools (kata 5715, pi e30g parity): generate_image /
 * edit_image / upload_image backed by the hosted LunaRoute MCP server — same
 * pattern as the web tools (kata gygp), minus local presence detection:
 * these names are LunaRoute-specific and the server's tools/list already
 * gates per-org entitlement/policy (exact-name matching, model enum baked
 * from the server schema). Generated/edited images are SAVED locally and
 * returned as `file://` attachments — the whole point on OpenCode, which
 * does not admit http(s) attachment URLs into model context.
 *
 * Server contract (pi, verified 2026-09-09 against lunaroute-hosted mcp.rs):
 * - generate_image/edit_image: prompt+model required, optional
 *   size/steps/guidance/negative_prompt/seed/output_format; `embed: true`
 *   adds an inline {"type":"image","data":<b64>} content part.
 * - upload_image: data (base64) XOR url; server sniffs codecs too, but the
 *   bytes must not leave the machine before OUR magic-byte check.
 * - Results are LINE-BASED text (not JSON) — parsed tolerantly below; the
 *   server's own lines are never rewritten, only appended to.
 *
 * Dropped vs pi (with the kata's blessing): the swappable-client facade,
 * registration generations, and drift reconciliation — pi mutates shared
 * registration state in one long-lived process; on OpenCode the tool map
 * rebuilds per instance (f2aj live-apply spike), so each instance re-probes
 * and re-registers wholesale, and the lazy per-execute key read covers
 * rotation without any of it.
 */

export const LUNAROUTE_ENV_IMAGE_DIR = "LUNAROUTE_IMAGE_DIR";
/** Mirrors the server's IMAGE_UPLOAD_MAX_BYTES default (11 MiB) — a
 * fail-fast guard before base64-inflating a file into JSON-RPC. The server
 * stays authoritative; deployments can configure it higher. */
export const UPLOAD_MAX_BYTES = 11 * 1024 * 1024;
/** Cap for the signed-URL image download: generous headroom over the
 * server's image ceilings while still bounding what a malformed or hostile
 * storage response can put in memory (pi roborev job 1672). */
export const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

// ============================================================================
// Result parsing (line-based server text → structured)
// ============================================================================

export interface ImageResult {
  verb: string;
  width: number;
  height: number;
  format: string;
  model: string;
  seed?: number;
  steps?: number;
  id: string;
  from?: string[];
  url?: string;
  urlExpires?: string;
  imageExpires?: string;
  /** Set when the text did not match the expected shape. */
  rawText?: string;
}

const UNAVAILABLE_URL = "url: (temporarily unavailable";

/** Parse the generate/edit result text. Tolerant: a parse failure keeps the
 * raw text so the model still sees what the server sent (web-tools
 * pattern). */
export function parseImageResultText(text: string): ImageResult {
  const lines = text.split("\n");
  const first = lines[0] ?? "";
  const head = /^(Generated|Edited into) (\d+)x(\d+) (\S+) with (.+)$/.exec(first);
  const idLine = lines.find((l) => l.startsWith("id: "));
  if (!head || !idLine) {
    return { verb: "", width: 0, height: 0, format: "", model: "", id: "", rawText: text };
  }
  let model = head[5];
  const detail = /\s*\(([^)]*)\)\s*$/.exec(model);
  let seed: number | undefined;
  let steps: number | undefined;
  if (detail) {
    model = model.slice(0, detail.index).trimEnd();
    const seedMatch = /seed (\d+)/.exec(detail[1]);
    const stepsMatch = /(\d+) steps/.exec(detail[1]);
    if (seedMatch) seed = Number(seedMatch[1]);
    if (stepsMatch) steps = Number(stepsMatch[1]);
  }
  const result: ImageResult = {
    verb: head[1],
    width: Number(head[2]),
    height: Number(head[3]),
    format: head[4] === "" ? "" : head[4],
    model,
    seed,
    steps,
    id: idLine.slice(4).trim(),
  };
  const fromLine = lines.find((l) => l.startsWith("from: "));
  if (fromLine) {
    result.from = fromLine
      .slice(6)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const urlLine = lines.find((l) => l.startsWith("url: "));
  if (urlLine && !urlLine.startsWith(UNAVAILABLE_URL)) {
    result.url = urlLine.slice(5).replace(/\s*\(link expires [^)]*\)\s*$/, "").trim();
    const expires = /\(link expires ([^)]*)\)/.exec(urlLine);
    if (expires) result.urlExpires = expires[1];
  }
  const imageExpires = lines.find((l) => l.startsWith("image expires: "));
  if (imageExpires) result.imageExpires = imageExpires.slice("image expires: ".length).trim();
  return result;
}

export interface UploadResult {
  id: string;
  width: number;
  height: number;
  format: string;
  mib: number;
  url?: string;
  urlExpires?: string;
  rawText?: string;
}

/** Parse the upload result text (`uploaded img_… (WxH fmt, N MiB)` + url). */
export function parseUploadResultText(text: string): UploadResult {
  const lines = text.split("\n");
  const head = /^uploaded (\S+) \((\d+)x(\d+) (\S+), ([0-9.]+) MiB\)$/.exec(lines[0] ?? "");
  if (!head) {
    return { id: "", width: 0, height: 0, format: "", mib: 0, rawText: text };
  }
  const result: UploadResult = {
    id: head[1],
    width: Number(head[2]),
    height: Number(head[3]),
    format: head[4],
    mib: Number(head[5]),
  };
  const urlLine = lines.find((l) => l.startsWith("url: "));
  if (urlLine && !urlLine.startsWith(UNAVAILABLE_URL)) {
    result.url = urlLine.slice(5).replace(/\s*\(link expires [^)]*\)\s*$/, "").trim();
    const expires = /\(link expires ([^)]*)\)/.exec(urlLine);
    if (expires) result.urlExpires = expires[1];
  }
  return result;
}

// ============================================================================
// Images dir + local safety (sniff, bounded reads, atomic save)
// ============================================================================

/** Per-installation images folder: LUNAROUTE_IMAGE_DIR (absolute) wins, else
 * <XDG data>/opencode/lunaroute-images — the same anchor as auth.json and
 * lunaroute.json (kata e30g: "matching the auth-store conventions"). */
export function resolveImageDir(env: NodeJS.ProcessEnv, home: string): string {
  const override = env[LUNAROUTE_ENV_IMAGE_DIR];
  if (typeof override === "string" && override) return override;
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(dataHome, "opencode", "lunaroute-images");
}

/** Sniff the image codec from magic bytes (pi roborev job 1646): the server
 * sniffs too, but the bytes must not LEAVE the machine before that check —
 * a path argument pointing at credentials must fail locally. */
export function sniffImageMime(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

function extForFormat(format: string): string {
  if (format === "jpeg") return ".jpg";
  if (format === "png" || format === "webp") return `.${format}`;
  return ".png";
}

function mimeForFormat(format: string): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

export interface ImageIo {
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Atomic rename (same-filesystem) for the temp-then-rename save. */
  rename(from: string, to: string): Promise<void>;
  /** Best-effort removal (temp cleanup). */
  rm(path: string): Promise<void>;
  /** Read at most maxBytes from the start of the file. The bound is
   * load-bearing: a path swapped for a huge file between checks must never
   * be fully loaded (pi roborev job 1659). */
  readFileBounded(path: string, maxBytes: number): Promise<Uint8Array>;
}

/** Collect bytes via repeated positional reads until EOF or maxBytes.
 * FileHandle.read may short-read before EOF (pi roborev job 1663) — a single
 * read could truncate an oversize file into something that passes the size
 * check, so the loop keeps reading until the file ends or the bound is hit.
 * The buffer stays one fixed maxBytes allocation. */
export async function readUntilLimit(
  readOnce: (buffer: Uint8Array, offset: number, length: number, position: number) => Promise<number>,
  maxBytes: number,
): Promise<Uint8Array> {
  const buffer = Buffer.alloc(maxBytes);
  let total = 0;
  while (total < maxBytes) {
    const bytesRead = await readOnce(buffer, total, maxBytes - total, total);
    if (bytesRead === 0) break; // EOF
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

export const defaultIo: ImageIo = {
  // fs mkdir returns Promise<string | undefined>; the interface promises void.
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
  writeFile,
  rename,
  rm,
  // Descriptor-based bounded read: one open, positional reads capped at
  // maxBytes — the file's true size never dictates memory use.
  readFileBounded: async (path, maxBytes) => {
    const handle = await open(path, "r");
    try {
      return await readUntilLimit(
        (buffer, offset, length, position) =>
          handle.read(buffer, offset, length, position).then((r) => r.bytesRead),
        maxBytes,
      );
    } finally {
      await handle.close();
    }
  },
};

export async function fetchImageBytes(
  url: string,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
  maxBytes: number = DOWNLOAD_MAX_BYTES,
): Promise<Uint8Array | undefined> {
  const res = await fetchImpl(url, { signal });
  if (!res.ok) return undefined;
  // Reject an honest oversized declaration up front…
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return undefined;
  // …and bound the actual bytes too: a lying or absent Content-Length must
  // not translate into an unbounded buffer. No readable body (null-body
  // responses) means there is nothing to save; there is deliberately NO
  // arrayBuffer fallback: it would buffer unbounded before the cap check
  // (pi roborev job 1696).
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** LunaRoute image ids are `img_` + ULID (upload design §2). Anything else —
 * especially path segments — is untrusted server input and must not reach a
 * filesystem path (pi roborev job 1649). */
const IMAGE_ID_PATTERN = /^img_[0-9A-Za-z]+$/;

async function saveImage(
  dir: string,
  id: string,
  format: string,
  bytes: Uint8Array,
  io: ImageIo,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!IMAGE_ID_PATTERN.test(id)) return undefined;
  if (signal?.aborted) return undefined;
  // Temp-then-rename (pi roborev job 1665): an abort landing mid-write (or a
  // failed write) must leave neither a partial nor a leftover file — the
  // final path only ever appears whole, via an atomic rename.
  const path = join(dir, `${id}${extForFormat(format)}`);
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await io.mkdir(dir, { recursive: true });
    // Re-check before the write: an abort landing between the download
    // resolving and this point must not leave a file behind (job 1661).
    if (signal?.aborted) return undefined;
    await io.writeFile(tmp, bytes);
    if (signal?.aborted) {
      await io.rm(tmp).catch(() => {});
      return undefined;
    }
    await io.rename(tmp, path);
    // The last window (job 1667): an abort landing during the rename must
    // not leave the completed file behind either — a cancelled call has no
    // side effects, matching the not-saved note.
    if (signal?.aborted) {
      await io.rm(path).catch(() => {});
      return undefined;
    }
    return path;
  } catch {
    await io.rm(tmp).catch(() => {});
    return undefined;
  }
}

function textParts(call: { content?: { type: string; text?: string }[] }): string {
  return (call.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

function imagePart(call: { content?: { type: string; data?: string }[] }): { type: string; data?: string } | undefined {
  return (call.content ?? []).find((c) => c.type === "image" && typeof c.data === "string");
}

// ============================================================================
// Tool builders
// ============================================================================

export type McpCall = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpToolCallResult>;

export interface ImageToolExecuteDeps {
  mcpToolName: string;
  /** One stateless call: resolves the CURRENT key (lazy re-read), builds a
   * fresh client, and dispatches — same rotation reach-through as the web
   * tools. */
  callServer: McpCall;
  /** Resolved save directory (gate-time: LUNAROUTE_IMAGE_DIR or the
   * XDG-data anchor). */
  imageDir: string;
  fetchImpl?: FetchLike;
  io?: ImageIo;
  /** Per-org model enum + hints from tools/list (kata e30g enum baking). */
  modelEnum?: { enum: string[]; description?: string };
}

/** Build the `model` parameter: the per-org enum + limit hints from the
 * server's tools/list when available, else a plain string. */
function modelParam(modelEnum: ImageToolExecuteDeps["modelEnum"]) {
  if (modelEnum && modelEnum.enum.length > 0) {
    return tool.schema
      .enum(modelEnum.enum as [string, ...string[]])
      .describe(modelEnum.description ?? "Which image model to use.");
  }
  return tool.schema.string().describe("Image model id, as offered by LunaRoute.");
}

export function buildGenerateImageTool(deps: ImageToolExecuteDeps): ToolDefinition {
  return tool({
    description:
      "Generate an image from a text prompt via LunaRoute. Returns the image id, a time-limited URL, and the local path where the image was saved. Pass the id to edit_image to modify it later.",
    args: {
      prompt: tool.schema.string().describe("What to generate"),
      model: modelParam(deps.modelEnum),
      size: tool.schema.string().describe("WIDTHxHEIGHT, e.g. 1024x1024. Defaults to the model's default size.").optional(),
      steps: tool.schema.number().describe("Denoising steps. Defaults to the model's default; must be in the model's range.").optional(),
      guidance: tool.schema.number().describe("Prompt adherence. Defaults to the model's default; must be in the model's range.").optional(),
      negative_prompt: tool.schema.string().describe("What to avoid. Only for models that support it.").optional(),
      seed: tool.schema.number().min(0).describe("Seed for a reproducible generation. Omit for a random one.").optional(),
      output_format: tool.schema.string().describe("One of the model's formats listed under model.").optional(),
    },
    async execute(args, context) {
      const call = await deps.callServer(deps.mcpToolName, { ...args, embed: true }, context.abort);
      return finishImageCall(call, deps, "generate_image", context.abort);
    },
  });
}

export function buildEditImageTool(deps: ImageToolExecuteDeps): ToolDefinition {
  return tool({
    description:
      "Edit prior images by their LunaRoute image id — the id returned by generate_image, a prior edit, or upload_image. Returns a new image id, URL, and the local path where it was saved.",
    args: {
      prompt: tool.schema.string().describe("What to change"),
      model: modelParam(deps.modelEnum),
      image_ids: tool.schema.array(tool.schema.string()).min(1).describe("Prior LunaRoute image ids to edit (img_…)"),
      size: tool.schema.string().describe("WIDTHxHEIGHT for the result").optional(),
      steps: tool.schema.number().describe("Denoising steps").optional(),
      guidance: tool.schema.number().describe("Prompt adherence").optional(),
      negative_prompt: tool.schema.string().describe("What to avoid (models that support it)").optional(),
      seed: tool.schema.number().min(0).describe("Seed for a reproducible edit").optional(),
      output_format: tool.schema.string().describe("One of the model's formats").optional(),
    },
    async execute(args, context) {
      const call = await deps.callServer(deps.mcpToolName, { ...args, embed: true }, context.abort);
      return finishImageCall(call, deps, "edit_image", context.abort);
    },
  });
}

/** Shared tail for generate/edit execute: parse, save (inline bytes, else the
 * signed url), and shape the text + metadata + attachment. Never rewrites
 * the server's own lines — only appends the local-path line. */
async function finishImageCall(
  call: McpToolCallResult,
  deps: ImageToolExecuteDeps,
  label: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  // Our own client throws on isError, but stay defensive: an error result
  // must fail the tool, not parse into "not saved locally" plus success-
  // looking guidance (pi roborev job 1694).
  if (call.isError) {
    throw new Error(textParts(call) || `MCP tool ${deps.mcpToolName} returned an error`);
  }
  const text = textParts(call);
  const parsed = parseImageResultText(text);
  let bytes: Uint8Array | undefined;
  const inline = imagePart(call);
  if (inline?.data) bytes = Buffer.from(inline.data, "base64");
  else if (parsed.url) {
    bytes = await fetchImageBytes(parsed.url, deps.fetchImpl ?? (fetch as FetchLike), signal).catch(() => undefined);
  }
  let path: string | undefined;
  if (bytes && parsed.id && !signal?.aborted) {
    try {
      path = await saveImage(deps.imageDir, parsed.id, parsed.format, bytes, deps.io ?? defaultIo, signal);
    } catch {
      // Best-effort: the id + url still go out.
    }
  }
  const outText = `${text}\n${path ? `saved to: ${path}` : "not saved locally — fetch the url before it expires"}`;
  const metadata = {
    id: parsed.id || undefined,
    path,
    url: parsed.url,
    width: parsed.width || undefined,
    height: parsed.height || undefined,
    format: parsed.format || undefined,
    model: parsed.model || undefined,
    seed: parsed.seed,
    steps: parsed.steps,
    from: parsed.from,
    bytes: bytes?.byteLength,
  };
  // The attachment is the point on OpenCode: a saved image becomes visible
  // to vision models as image media (http(s) URLs would not be).
  const attachments = path
    ? [{ type: "file" as const, mime: mimeForFormat(parsed.format), url: pathToFileURL(path).href, filename: basename(path) }]
    : undefined;
  return {
    title: `${label}: ${parsed.id || "(no id)"}`,
    output: outText,
    metadata,
    ...(attachments ? { attachments } : {}),
  };
}

export function buildUploadImageTool(deps: ImageToolExecuteDeps): ToolDefinition {
  return tool({
    description:
      "Upload an image you already have (a local file path, or an http(s) URL) to LunaRoute and get an img_… id. Pass that id to edit_image's image_ids to edit it.",
    args: {
      path: tool.schema.string().describe("Local path of the image file (png, jpeg, or webp). Exactly one of path or url.").optional(),
      url: tool.schema.string().describe("http(s) URL of the image to fetch server-side. Exactly one of path or url.").optional(),
    },
    async execute(args, context) {
      const io = deps.io ?? defaultIo;
      let callArgs: Record<string, unknown>;
      if (args.path && args.url) {
        throw new Error("exactly one of path or url is required, not both");
      } else if (args.path) {
        // Bounded read (pi roborev jobs 1651 + 1659): at most the ceiling + 1
        // byte ever enters memory, whatever happens to the file between
        // checks.
        const data = await io.readFileBounded(args.path, UPLOAD_MAX_BYTES + 1);
        if (data.byteLength > UPLOAD_MAX_BYTES) {
          throw new Error(`${args.path} exceeds the ${(UPLOAD_MAX_BYTES / (1024 * 1024)) | 0} MiB LunaRoute upload ceiling`);
        }
        const sniffed = sniffImageMime(data);
        if (!sniffed) {
          throw new Error(
            `${args.path} is not a png, jpeg, or webp image (magic bytes not recognized) — refusing to upload it`,
          );
        }
        callArgs = { data: Buffer.from(data).toString("base64"), mime_type: sniffed };
      } else if (args.url) {
        // The server's SSRF-safe fetch rejects non-http(s) schemes too, but
        // fail fast locally — the documented contract is http(s) (job 1656).
        let parsed: URL;
        try {
          parsed = new URL(args.url);
        } catch {
          throw new Error(`"${args.url}" is not a valid URL`);
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error(`upload_image urls must be http(s), got ${parsed.protocol}//`);
        }
        callArgs = { url: args.url };
      } else {
        throw new Error("exactly one of path or url is required");
      }
      const call = await deps.callServer(deps.mcpToolName, callArgs, context.abort);
      if (call.isError) {
        // Same defense as finishImageCall: an error result fails the tool
        // instead of gaining the edit hint.
        throw new Error(textParts(call) || `MCP tool ${deps.mcpToolName} returned an error`);
      }
      const text = textParts(call);
      const parsed = parseUploadResultText(text);
      const metadata = {
        id: parsed.id || undefined,
        url: parsed.url,
        width: parsed.width || undefined,
        height: parsed.height || undefined,
        format: parsed.format || undefined,
        mib: parsed.mib || undefined,
      };
      return {
        title: `upload_image: ${parsed.id || "(no id)"}`,
        output: `${text}\npass this id to edit_image's image_ids to edit it.`,
        metadata,
      };
    },
  });
}

// ============================================================================
// Registration gate
// ============================================================================

export interface ImageToolMapDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  mcpUrl: string;
  sessionId: string;
  fetchImpl?: FetchLike;
  log?: (level: "info" | "warn", message: string) => void;
  resolveKey: () => Promise<AuthResolution>;
  readSettingsNow: () => LunarouteSettings;
  /** Pre-fetched tools/list descriptors (the shared probe in index.ts). */
  descriptors?: { name: string; inputSchema?: unknown }[];
  io?: ImageIo;
}

/** Extract the per-org `model` enum + hint description from a tools/list
 * inputSchema (the server bakes per-model limits into the description). */
export function extractModelEnum(inputSchema: unknown): { enum: string[]; description?: string } | undefined {
  if (typeof inputSchema !== "object" || inputSchema === null) return undefined;
  const properties = (inputSchema as { properties?: Record<string, unknown> }).properties;
  const model = properties?.model;
  if (typeof model !== "object" || model === null) return undefined;
  const { enum: values, description } = model as { enum?: unknown; description?: unknown };
  if (!Array.isArray(values) || values.length === 0) return undefined;
  if (!values.every((v): v is string => typeof v === "string")) return undefined;
  return {
    enum: values,
    description: typeof description === "string" ? description : undefined,
  };
}

/** Build the first-class image tool map. Never throws; every failure path
 * returns fewer (or no) tools — same contract as the web-tools gate. */
export async function buildImageToolMap(deps: ImageToolMapDeps): Promise<Record<string, ToolDefinition>> {
  if (!imageToolsEnabled(deps.env, deps.readSettingsNow())) return {};
  const resolution = await deps.resolveKey();
  if (resolution.state !== "valid") return {}; // logged out / indeterminate → no tools, silent

  const headers = (key: string): Record<string, string> => ({
    "LUNAROUTE-API-KEY": key,
    ...buildAttributionHeaders(deps.sessionId),
  });
  const fetchImpl = deps.fetchImpl ?? (fetch as FetchLike);

  // Fresh client + fresh key per call: rotation reach-through, nothing
  // shared between concurrent executes.
  const callServer: McpCall = async (name, args, signal) => {
    const current = await deps.resolveKey();
    if (current.state !== "valid") throw new Error(authErrorMessage(current));
    return createLunarouteMcpClient({ url: deps.mcpUrl, headers: headers(current.key), fetchImpl }).callTool(name, args, signal);
  };

  let descriptors = deps.descriptors;
  if (!descriptors) {
    try {
      descriptors = await listServerToolDescriptors({
        url: deps.mcpUrl,
        key: resolution.key,
        sessionId: deps.sessionId,
        fetchImpl,
        timeoutMs: WEB_TOOLS_PROBE_TIMEOUT_MS,
      });
    } catch (err) {
      deps.log?.("warn", `LunaRoute: image tools not registered (tools/list failed: ${err instanceof Error ? err.message : String(err)})`);
      return {};
    }
  }

  const byName = new Map(descriptors.map((d) => [d.name, d]));
  const imageDir = resolveImageDir(deps.env, deps.home);
  const map: Record<string, ToolDefinition> = {};
  if (byName.has("generate_image")) {
    map.generate_image = buildGenerateImageTool({
      mcpToolName: "generate_image",
      callServer,
      imageDir,
      fetchImpl,
      io: deps.io,
      modelEnum: extractModelEnum(byName.get("generate_image")?.inputSchema),
    });
  }
  if (byName.has("edit_image")) {
    map.edit_image = buildEditImageTool({
      mcpToolName: "edit_image",
      callServer,
      imageDir,
      fetchImpl,
      io: deps.io,
      modelEnum: extractModelEnum(byName.get("edit_image")?.inputSchema),
    });
  }
  if (byName.has("upload_image")) {
    map.upload_image = buildUploadImageTool({ mcpToolName: "upload_image", callServer, imageDir, fetchImpl, io: deps.io });
  }
  return map;
}

// Local helper: auth error message (same shape as the web gate; worded for
// image tools).
function authErrorMessage(resolution: AuthResolution): string {
  if (resolution.state === "logged-out") {
    return "LunaRoute: logged out since this session started — run /connect and choose LunaRoute to log in again.";
  }
  if (resolution.state === "indeterminate") {
    return `LunaRoute: auth store unreadable (${resolution.reason}) — cannot call LunaRoute image tools.`;
  }
  return "LunaRoute: auth state unavailable — cannot call LunaRoute image tools.";
}
