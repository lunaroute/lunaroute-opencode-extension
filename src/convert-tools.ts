import { tool, type ToolDefinition, type ToolResult } from "@opencode-ai/plugin";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { AuthResolution } from "./mcp.js";
import { buildAttributionHeaders } from "./lunaroute.js";
import { convertToolsEnabled, type LunarouteSettings } from "./settings.js";
import {
  createLunarouteMcpClient,
  listServerToolDescriptors,
  WEB_TOOLS_PROBE_TIMEOUT_MS,
  type FetchLike,
  type McpToolCallResult,
} from "./web-tools.js";
import { defaultIo, fetchImageBytes, sniffImageMime, type ImageIo } from "./image-tools.js";

/**
 * First-class convert_document tool (kata gv7t, pi zpzt parity): documents
 * (Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF; raster images
 * always OCR'd) → Markdown via the hosted LunaRoute MCP server — same
 * pattern as the web (gygp) and image (5715) tools, with those katas'
 * review-loop lessons baked in from day one.
 *
 * Server contract (pi, verified 2026-09-10 against lunaroute-hosted mcp.rs):
 * - convert_document: url XOR data (base64) + optional filename (format
 *   hint, REQUIRED for CSV) + ocr (default false) + embed (default true).
 * - embed:true → markdown inline, capped server-side; over it the server
 *   answers `output_too_large` ("try embed: false").
 * - embed:false → stored doc_<ULID> artifact + `url: <signed> (link expires
 *   <ts>)` result, 7-day retention. With stock server defaults both caps
 *   are 1 MiB, so the fallback can fail the same way — surfaced honestly.
 * - needs_ocr: scanned PDF with ocr:false → error; the MODEL retries with
 *   ocr: true (the costly path is its decision — no auto-retry here).
 * - tool_error text is "<code>: <message>".
 *
 * OpenCode adaptations: full text returned (host truncates/spills — pi's
 * `.md` spill convention is deliberately NOT re-implemented, kata gv7t);
 * zod schemas; callServer per-execute pattern (rotation reach-through);
 * gate + wiring identical to the image tools. Dropped pi's registration
 * machinery (per-instance rebuild covers it — f2aj spike).
 */

export const LUNAROUTE_ENV_DOCS_DIR = "LUNAROUTE_DOCS_DIR";
/** Mirrors the server's MCP_DOC_MAX_INPUT_BYTES default (10 MiB) — a
 * fail-fast guard before base64-inflating a file into JSON-RPC. The server
 * stays authoritative; deployments can configure it higher. */
export const CONVERT_MAX_INPUT_BYTES = 10 * 1024 * 1024;

// ============================================================================
// Pure helpers
// ============================================================================

export interface ArtifactLink {
  url: string;
  expiresAt?: string;
}

/** Parse the embed:false artifact result — the same link_line contract the
 * image tools consume: `url: <signed> (link expires <ts>)`. */
export function parseArtifactUrl(text: string): ArtifactLink | undefined {
  for (const line of text.split("\n")) {
    if (!line.startsWith("url: ")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw.startsWith("(temporarily unavailable")) return undefined;
    const expires = /\(link expires ([^)]*)\)/.exec(raw);
    return {
      url: raw.replace(/\s*\(link expires [^)]*\)\s*$/, "").trim(),
      expiresAt: expires?.[1],
    };
  }
  return undefined;
}

/** Per-installation documents folder: LUNAROUTE_DOCS_DIR (absolute) wins,
 * else <XDG data>/opencode/lunaroute-docs — the same anchor as auth.json,
 * lunaroute.json, and the images dir. */
export function resolveDocsDir(env: NodeJS.ProcessEnv, home: string): string {
  const override = env[LUNAROUTE_ENV_DOCS_DIR];
  if (typeof override === "string" && override) return override;
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(dataHome, "opencode", "lunaroute-docs");
}

export type DocumentFormat =
  | { kind: "binary"; format: "zip" | "pdf" | "rtf" }
  | { kind: "binary"; format: "image"; mime: string }
  | { kind: "text" };

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** The ODF document mimetype allowlist (the documented OpenDocument family
 * the server converts). */
const ODF_MIMETYPES: ReadonlySet<string> = new Set([
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.graphics",
  "application/vnd.oasis.opendocument.chart",
  "application/vnd.oasis.opendocument.formula",
  "application/vnd.oasis.opendocument.image",
]);

/** Recognized ZIP-based document containers, parsed properly (roborev
 * follow-up on the byte-scan): the End of Central Directory is located, the
 * central directory walked, and the container must match one of:
 * - OOXML: an entry named exactly `[Content_Types].xml` plus an entry under
 *   `word/`, `ppt/`, or `xl/`;
 * - ODF: an entry named exactly `mimetype`, STORED (method 0, per spec),
 *   whose content starts with `application/vnd.oasis.opendocument.`;
 * - EPUB: the same `mimetype` entry with content exactly
 *   `application/epub+zip`.
 * Marker strings inside unrelated filenames or file data do not count.
 * Malformed archives fail closed. */
function recognizedZipContainer(bytes: Uint8Array): boolean {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number): number => (o >= 0 && o + 2 <= buf.length ? buf.readUInt16LE(o) : -1);
  const u32 = (o: number): number => (o >= 0 && o + 4 <= buf.length ? buf.readUInt32LE(o) : -1);
  // Locate the End of Central Directory (variable-length comment → scan the tail).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return false;
  const count = u16(eocd + 10);
  let offset = u32(eocd + 16);
  if (count <= 0 || offset < 0 || offset >= buf.length) return false;
  const names: string[] = [];
  let mimetypeContent: string | undefined;
  for (let i = 0; i < count; i++) {
    if (u32(offset) !== 0x02014b50) return false;
    const method = u16(offset + 10);
    const nameLen = u16(offset + 28);
    const extraLen = u16(offset + 30);
    const commentLen = u16(offset + 32);
    const localOffset = u32(offset + 42);
    if (offset + 46 + nameLen > buf.length) return false;
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);
    names.push(name);
    if (name === "mimetype" && method === 0) {
      // The mimetype entry must be STORED; read its content through the
      // local header (name/extra lengths are per-entry there). ODF/EPUB
      // spec: mimetype is the FIRST local entry, and its local name and
      // stored sizes must agree with the central record — a central record
      // pointing at an unrelated local entry does not make this a document
      // container (roborev follow-up round 2).
      const contentLen = u32(offset + 24); // uncompressed size == stored size
      if (localOffset !== 0) return false; // must be the first local entry
      if (u32(localOffset) !== 0x04034b50) return false;
      if (u16(localOffset + 8) !== 0) return false; // local method must be stored too
      const lNameLen = u16(localOffset + 26);
      const lExtraLen = u16(localOffset + 28);
      if (localOffset + 30 + lNameLen > buf.length) return false;
      if (buf.toString("utf8", localOffset + 30, localOffset + 30 + lNameLen) !== "mimetype") return false;
      const lCsize = u32(localOffset + 18);
      const lUsize = u32(localOffset + 22);
      if (lCsize !== contentLen || lUsize !== contentLen) return false;
      const contentStart = localOffset + 30 + lNameLen + lExtraLen;
      if (contentLen <= 0 || contentStart < 0 || contentStart + contentLen > buf.length) return false;
      mimetypeContent = buf.toString("latin1", contentStart, contentStart + contentLen);
    }
    offset += 46 + nameLen + extraLen + commentLen;
    if (offset > buf.length) return false;
  }
  const isOoxml =
    names.includes("[Content_Types].xml") &&
    names.some((n) => n.startsWith("word/") || n.startsWith("ppt/") || n.startsWith("xl/"));
  const mimetype = mimetypeContent;
  // ODF subtypes are allowlisted exactly — a fabricated
  // application/vnd.oasis.opendocument.not-a-document must not pass
  // (roborev follow-up round 3).
  const isOdf = mimetype !== undefined && ODF_MIMETYPES.has(mimetype);
  const isEpub = mimetype === "application/epub+zip";
  return isOoxml || isOdf || isEpub;
}

/** Local format guard (the upload_image exfiltration precedent, amended in
 * the zpzt brainstorm): binary formats are sniffed by magic — ZIP-family
 * (docx/pptx/xlsx/odt/epub), PDF, RTF, raster images — and text must be
 * valid UTF-8 (CSV et al. — no delimiter heuristic; claimed-CSV is an
 * agent-trust boundary every text-carrying tool shares). Unrecognized input
 * is rejected before any bytes leave the machine. */
export function sniffDocumentFormat(bytes: Uint8Array): DocumentFormat | undefined {
  if (bytes.length === 0) return undefined; // nothing to convert
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    // ZIP-family: a bare PK marker accepts ANY archive — backups, credential
    // bundles, things the server cannot convert — and a byte-scan for marker
    // strings is padded away by a hostile archive (roborev follow-up). The
    // central directory is parsed and the container must match a recognized
    // structure exactly; malformed → rejected (fail closed). The server
    // remains the format authority.
    if (recognizedZipContainer(bytes)) return { kind: "binary", format: "zip" };
    return undefined;
  }
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return { kind: "binary", format: "pdf" }; // %PDF-
  }
  if (bytes.length >= 5 && bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74 && bytes[4] === 0x66) {
    return { kind: "binary", format: "rtf" }; // {\rtf
  }
  const imageMime = sniffImageMime(bytes);
  if (imageMime) {
    return { kind: "binary", format: "image", mime: imageMime };
  }
  try {
    utf8Decoder.decode(bytes);
    return { kind: "text" };
  } catch {
    return undefined; // not a recognized binary format, not UTF-8 → reject
  }
}

function textParts(call: { content?: { type: string; text?: string }[] }): string {
  return (call.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sanitizeBaseName(name: string): string {
  const stem = name.replace(/\.[^.]*$/, "").replace(/[^0-9A-Za-z._-]+/g, "_");
  return stem || "document";
}

// ============================================================================
// Document save (the full e30g review-loop discipline + the 5715 permission
// lesson)
// ============================================================================

/** Atomic, abort-aware document save: temp-then-rename, cancellation
 * re-checks before and after every await, and a unique suffix when a
 * different file already occupies the target name — identical content keeps
 * the same path (idempotent re-conversion). Private by default (dir 0700 /
 * file 0600); the directory is hardened ONLY for the plugin-owned default —
 * an explicit LUNAROUTE_DOCS_DIR is respected as-is (user-managed), same
 * rule as the image tools. */
export async function saveDocument(
  dir: string,
  baseName: string,
  bytes: Uint8Array,
  io: ImageIo,
  signal?: AbortSignal,
  hardenDir = false,
): Promise<string | undefined> {
  if (signal?.aborted) return undefined;
  // Hoisted so the catch always removes the REAL temp file (pi roborev 1713).
  let finalTmp: string | undefined;
  try {
    await io.mkdir(dir, { recursive: true, mode: 0o700 });
    if (hardenDir) await io.chmod(dir, 0o700).catch(() => {});
    if (signal?.aborted) return undefined;
    const target = join(dir, `${baseName}.md`);
    finalTmp = `${target}.${randomUUID()}.tmp`;
    await io.writeFile(finalTmp, bytes, { mode: 0o600 });
    if (signal?.aborted) {
      await io.rm(finalTmp).catch(() => {});
      return undefined;
    }
    // Atomic no-replace publish: link fails with EEXIST when the target
    // exists, so a concurrent conversion's file is never clobbered (the
    // old pre-rename existence check was a TOCTOU — roborev this repo).
    // On EEXIST: identical content → keep the shared path (idempotent);
    // different content → unique suffix, retried once.
    let finalPath = target;
    try {
      await io.link(finalTmp, finalPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== "EEXIST") {
        await io.rm(finalTmp).catch(() => {});
        return undefined;
      }
      const existing = await io.readFileBounded(target, bytes.byteLength + 1).catch(() => undefined);
      if (existing !== undefined && buffersEqual(existing, bytes)) {
        await io.rm(finalTmp).catch(() => {});
        return target; // idempotent re-conversion
      }
      finalPath = join(dir, `${baseName}-${randomUUID().slice(0, 6)}.md`);
      try {
        await io.link(finalTmp, finalPath);
      } catch {
        await io.rm(finalTmp).catch(() => {});
        return undefined;
      }
    }
    // Published. The link left our temp file behind — clean it up (the
    // TARGET is never deleted: a concurrent identical writer's output must
    // not be removed on someone else's content equality, pi roborev 1727,
    // and unlike the image tools' unique img_ ids, document names are
    // shared; the file is trivially reproducible by re-converting).
    await io.rm(finalTmp).catch(() => {});
    return finalPath;
  } catch {
    if (finalTmp !== undefined) {
      await io.rm(finalTmp).catch(() => {});
    }
    return undefined;
  }
}

// ============================================================================
// Tool builder
// ============================================================================

export type McpCall = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpToolCallResult>;

export interface ConvertToolExecuteDeps {
  mcpToolName: string;
  /** One stateless call: resolves the CURRENT key (lazy re-read), builds a
   * fresh client, and dispatches — rotation reach-through as in the other
   * first-class tools. */
  callServer: McpCall;
  /** Resolved documents dir (gate-time: LUNAROUTE_DOCS_DIR or the XDG-data
   * anchor) — used only by the output_too_large fallback. */
  docsDir: string;
  /** Harden the docs dir to 0700 on save — true only for the plugin-owned
   * default dir, never for an explicit LUNAROUTE_DOCS_DIR. */
  hardenDocsDir?: boolean;
  fetchImpl?: FetchLike;
  io?: ImageIo;
}

export function buildConvertTool(deps: ConvertToolExecuteDeps): ToolDefinition {
  return tool({
    description:
      "Convert a document (Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF) or a raster image into Markdown via LunaRoute. " +
      "Returns the Markdown inline; oversized documents are stored as artifacts and saved to the local documents folder, with the path returned.",
    args: {
      path: tool.schema
        .string()
        .describe(
          "Local path of the document (Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF; raster images are OCR'd). Exactly one of path or url.",
        )
        .optional(),
      url: tool.schema.string().describe("http(s) URL of the document to convert. Exactly one of path or url.").optional(),
      filename: tool.schema
        .string()
        .describe(
          "Format hint like report.csv; required for CSV. Derived from the local path when omitted; set it explicitly for URLs.",
        )
        .optional(),
      ocr: tool.schema
        .boolean()
        .describe(
          "OCR scanned PDF pages via the configured backend (the costly path). Default false: scanned pages answer needs_ocr — retry with ocr: true.",
        )
        .optional(),
    },
    async execute(args, context) {
      const io = deps.io ?? defaultIo;
      const signal = context.abort;
      let callArgs: Record<string, unknown>;
      let filename: string | undefined = args.filename;
      if (args.path && args.url) {
        throw new Error("exactly one of path or url is required, not both");
      } else if (args.path) {
        // Bounded read: at most the ceiling + 1 byte ever enters memory,
        // whatever happens to the file between checks (e30g discipline).
        // noFollow: the path-trust policy requires the bytes to come from
        // the file at the stated path — a report.csv symlink to a private
        // key must fail here, not sail past the guard (roborev this repo).
        let data: Uint8Array;
        try {
          data = await io.readFileBounded(args.path, CONVERT_MAX_INPUT_BYTES + 1, { noFollow: true });
        } catch (err) {
          if ((err as NodeJS.ErrnoException | null)?.code === "ELOOP") {
            throw new Error(`${args.path} is a symbolic link — convert the real file instead (symlinks are refused for safety)`);
          }
          throw err;
        }
        if (data.byteLength > CONVERT_MAX_INPUT_BYTES) {
          throw new Error(`${args.path} exceeds the ${(CONVERT_MAX_INPUT_BYTES / (1024 * 1024)) | 0} MiB LunaRoute conversion ceiling`);
        }
        const format = sniffDocumentFormat(data);
        if (!format) {
          throw new Error(
            `${args.path} is not a recognized document (docx/pptx/xlsx/odt/epub/pdf/rtf/csv/image) — refusing to upload it`,
          );
        }
        filename ??= basename(args.path);
        if (format.kind === "text") {
          // Text-upload policy (pi roborev 1715) — the security boundary,
          // verbatim: the server only converts CSV as text, so a text file
          // only leaves the machine when it is claimed as .csv — from a
          // .csv path, or an extensionless path with an explicit .csv
          // filename. Dotfiles, keys, configs, and source files stay local;
          // binary formats are unaffected (magic sniffed above).
          // Separators are normalized first so Windows-style hidden paths
          // cannot launder past the guard (pi roborev 1727).
          const normalizedPath = args.path.replace(/\\/g, "/");
          const pathBase = basename(normalizedPath);
          const ext = (name: string): string => {
            const dot = name.lastIndexOf(".");
            return dot > 0 ? name.slice(dot).toLowerCase() : "";
          };
          const pathExt = ext(pathBase);
          const claimExt = ext(filename);
          const claimedCsv = claimExt === ".csv" && (pathExt === ".csv" || pathExt === "");
          // Hidden path components (dotfiles, .ssh/.aws/…) never leave the
          // machine as text, whatever they claim. The exactly-"." component
          // is exempt so ordinary relative paths (./data.csv) work; ".."
          // traversal and dotfiles still refuse.
          const hiddenComponent = normalizedPath
            .split("/")
            .some((c) => c.startsWith(".") && c !== ".");
          if (!claimedCsv || pathBase.startsWith(".") || hiddenComponent) {
            throw new Error(
              `${args.path} is plain text — only .csv files are converted as text (binary formats are detected by content)`,
            );
          }
        }
        callArgs = {
          data: Buffer.from(data).toString("base64"),
          filename,
          ...(args.ocr !== undefined && { ocr: args.ocr }),
        };
      } else if (args.url) {
        let parsed: URL;
        try {
          parsed = new URL(args.url);
        } catch {
          throw new Error(`"${args.url}" is not a valid URL`);
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error(`convert_document urls must be http(s), got ${parsed.protocol}//`);
        }
        callArgs = {
          url: args.url,
          ...(filename !== undefined && { filename }),
          ...(args.ocr !== undefined && { ocr: args.ocr }),
        };
      } else {
        throw new Error("exactly one of path or url is required");
      }

      // Both error shapes route output_too_large to the fallback: our own
      // client THROWS on isError, but stay defensive for other client shapes
      // (the e30g/roborev-1694 lesson). The fallback itself runs OUTSIDE
      // this try — its own errors must never re-enter the catch and trigger
      // a duplicate fallback conversion (pi roborev 1713: the original bug
      // tripled server calls).
      let markdown: string | undefined;
      let fallbackError: string | undefined;
      try {
        const call = await deps.callServer(deps.mcpToolName, { ...callArgs, embed: true }, signal);
        if (call.isError) {
          const message = textParts(call);
          if (/output_too_large/.test(message)) {
            fallbackError = message;
          } else {
            throw new Error(message || `MCP tool ${deps.mcpToolName} returned an error`);
          }
        } else {
          markdown = textParts(call);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/output_too_large/.test(message)) throw err;
        fallbackError = message;
      }
      if (fallbackError !== undefined) {
        return convertFallback(callArgs, filename, deps, io, signal, fallbackError);
      }
      return {
        title: `convert_document: ${filename ?? args.url ?? "document"}`,
        output: markdown as string,
        metadata: { filename, bytes: Buffer.byteLength(markdown as string, "utf8"), ocr: args.ocr },
      };
    },
  });
}

/** The output_too_large fallback: retry with embed:false, download the
 * artifact, save it to the docs dir. With stock server defaults both caps
 * are 1 MiB so the retry may fail the same way — that error is surfaced
 * honestly. The retry re-runs the whole conversion (no store-previous
 * result API server-side). */
async function convertFallback(
  callArgs: Record<string, unknown>,
  filename: string | undefined,
  deps: ConvertToolExecuteDeps,
  io: ImageIo,
  signal: AbortSignal | undefined,
  originalError: string,
): Promise<ToolResult> {
  const call = await deps.callServer(deps.mcpToolName, { ...callArgs, embed: false }, signal);
  if (call.isError) {
    throw new Error(textParts(call) || `MCP tool ${deps.mcpToolName} returned an error`);
  }
  const text = textParts(call);
  const link = parseArtifactUrl(text);
  if (!link) {
    return {
      title: `convert_document: ${filename ?? "document"}`,
      output: `output_too_large fallback did not return an artifact url — ${originalError}`,
      metadata: { filename },
    };
  }
  const bytes = await fetchImageBytes(link.url, deps.fetchImpl ?? (fetch as FetchLike), signal).catch(() => undefined);
  if (!bytes) {
    return {
      title: `convert_document: ${filename ?? "document"}`,
      output: `${text}\n(the artifact could not be downloaded locally — fetch the url before it expires)`,
      metadata: { filename, artifactUrl: link.url },
    };
  }
  const baseName = sanitizeBaseName(filename ?? "document");
  const path = await saveDocument(deps.docsDir, baseName, bytes, io, signal, deps.hardenDocsDir);
  if (!path) {
    return {
      title: `convert_document: ${filename ?? "document"}`,
      output: `${text}\n(the document could not be saved locally — fetch the url before it expires)`,
      metadata: { filename, artifactUrl: link.url, bytes: bytes.byteLength },
    };
  }
  const head = Buffer.from(bytes).toString("utf8").slice(0, 1500);
  return {
    title: `convert_document: ${path}`,
    output: `full document saved to: ${path}\n(link expires ${link.expiresAt ?? "soon"})\n\n${head}${head.length >= 1500 ? "\n…" : ""}`,
    metadata: { filename, path, artifactUrl: link.url, bytes: bytes.byteLength },
  };
}

// ============================================================================
// Registration gate
// ============================================================================

export interface ConvertToolMapDeps {
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

/** Build the first-class convert_document tool map. Never throws; every
 * failure path returns fewer (or no) tools — same contract as the other
 * gates. */
export async function buildConvertToolMap(deps: ConvertToolMapDeps): Promise<Record<string, ToolDefinition>> {
  if (!convertToolsEnabled(deps.env, deps.readSettingsNow())) return {};
  const resolution = await deps.resolveKey();
  if (resolution.state !== "valid") return {}; // logged out / indeterminate → no tools, silent

  const headers = (key: string): Record<string, string> => ({
    "LUNAROUTE-API-KEY": key,
    ...buildAttributionHeaders(deps.sessionId),
  });
  const fetchImpl = deps.fetchImpl ?? (fetch as FetchLike);

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
      deps.log?.("warn", `LunaRoute: convert tool not registered (tools/list failed: ${err instanceof Error ? err.message : String(err)})`);
      return {};
    }
  }

  if (!descriptors.some((d) => d.name === "convert_document")) return {};
  const override = deps.env[LUNAROUTE_ENV_DOCS_DIR];
  const hardenDocsDir = !(typeof override === "string" && override); // only the plugin-owned default dir is ours to clamp
  return {
    convert_document: buildConvertTool({
      mcpToolName: "convert_document",
      callServer,
      docsDir: resolveDocsDir(deps.env, deps.home),
      hardenDocsDir,
      fetchImpl,
      io: deps.io,
    }),
  };
}

function authErrorMessage(resolution: AuthResolution): string {
  if (resolution.state === "logged-out") {
    return "LunaRoute: logged out since this session started — run /connect and choose LunaRoute to log in again.";
  }
  if (resolution.state === "indeterminate") {
    return `LunaRoute: auth store unreadable (${resolution.reason}) — cannot call the LunaRoute convert tool.`;
  }
  return "LunaRoute: auth state unavailable — cannot call the LunaRoute convert tool.";
}
