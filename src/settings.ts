import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * LunaRoute user settings — READ side (kata gygp).
 *
 * Ported from pi's settings.ts (pi kata bjy9, v0.9.0) so the gygp contract
 * holds: the settings file is the source of truth, read per execute, with an
 * env escape hatch that only ever disables. The WRITE path (atomic writes,
 * the /lunaroute TUI command, live apply, the mcp/image/convert toggles'
 * consumers) is f2aj's scope and lands there; until then an absent file
 * equals DEFAULT_SETTINGS equals the pre-settings behavior byte-for-byte.
 *
 * File: `<XDG data>/opencode/lunaroute.json` — next to OpenCode's auth store
 * (resolveAuthStorePath uses the same base). The location is this kata's
 * assumption; f2aj owns the file contract going forward and may relocate it
 * (reads are tolerant either way).
 */

export type Toggle = "on" | "off";
/** `server` = omit the provider argument; the LunaRoute server default wins. */
export type SearchProviderSetting = "server" | "brave" | "exa" | "kagi";
/** Concrete provider sent to the MCP tool; undefined = server default. */
export type ConcreteSearchProvider = Exclude<SearchProviderSetting, "server">;

export interface LunarouteSettings {
  mcp: Toggle;
  webTools: Toggle;
  searchProvider: SearchProviderSetting;
  imageTools: Toggle;
  convertTools: Toggle;
}

export const DEFAULT_SETTINGS: LunarouteSettings = {
  mcp: "on",
  webTools: "on",
  searchProvider: "server",
  imageTools: "on",
  convertTools: "on",
};

/** Static v1 list (pi parity); the server may support more. */
export const SEARCH_PROVIDERS: readonly SearchProviderSetting[] = ["server", "brave", "exa", "kagi"] as const;

/** Env escape hatches — only ever disable (off|0|false), mirroring pi. */
export const LUNAROUTE_ENV_WEB_TOOLS = "LUNAROUTE_WEB_TOOLS";
export const LUNAROUTE_ENV_IMAGE_TOOLS = "LUNAROUTE_IMAGE_TOOLS";
export const LUNAROUTE_ENV_CONVERT_TOOLS = "LUNAROUTE_CONVERT_TOOLS";

// ============================================================================
// IO (injectable for tests; default = node:fs)
// ============================================================================

export interface SettingsIo {
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  randomUUID(): string;
}

const defaultIo: SettingsIo = {
  readFileSync: (path) => readFileSync(path, "utf8"),
  writeFileSync,
  renameSync,
  randomUUID,
};

export function resolveSettingsPath(env: NodeJS.ProcessEnv, home: string): string {
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(dataHome, "opencode", "lunaroute.json");
}

function parseToggle(value: unknown, fallback: Toggle): Toggle {
  return value === "on" || value === "off" ? value : fallback;
}

function parseSearchProvider(value: unknown): SearchProviderSetting {
  return typeof value === "string" && (SEARCH_PROVIDERS as readonly string[]).includes(value)
    ? (value as SearchProviderSetting)
    : DEFAULT_SETTINGS.searchProvider;
}

/** Read settings, tolerantly: missing file falls back silently; an
 * unreadable or malformed file falls back to defaults AND reports via
 * `onInvalid` (kata f2aj: "defaults + warn, never crash") when provided.
 * Per-key invalid values fall back silently (tolerant reader, pi parity).
 * Extra keys are ignored. Never throws. */
export function readSettings(
  env: NodeJS.ProcessEnv,
  home: string,
  io: SettingsIo = defaultIo,
  onInvalid?: (reason: string) => void,
): LunarouteSettings {
  let raw: string;
  try {
    raw = io.readFileSync(resolveSettingsPath(env, home));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT") onInvalid?.(`settings file unreadable (${code ?? "unknown error"})`);
    return { ...DEFAULT_SETTINGS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    onInvalid?.("settings file is not valid JSON");
    return { ...DEFAULT_SETTINGS };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    onInvalid?.("settings file is not a JSON object");
    return { ...DEFAULT_SETTINGS };
  }
  const obj = parsed as Record<string, unknown>;
  return {
    mcp: parseToggle(obj.mcp, DEFAULT_SETTINGS.mcp),
    webTools: parseToggle(obj.webTools, DEFAULT_SETTINGS.webTools),
    searchProvider: parseSearchProvider(obj.searchProvider),
    imageTools: parseToggle(obj.imageTools, DEFAULT_SETTINGS.imageTools),
    convertTools: parseToggle(obj.convertTools, DEFAULT_SETTINGS.convertTools),
  };
}

// ============================================================================
// Decisions (pure)
// ============================================================================

/** Atomically write the canonical five-key settings file (tmp + rename — a
 * crash mid-write can never leave a truncated file). The file is ours:
 * unknown keys read earlier are not preserved. Throws on IO failure —
 * callers decide whether that is fatal. */
export function writeSettings(
  env: NodeJS.ProcessEnv,
  home: string,
  settings: LunarouteSettings,
  io: SettingsIo = defaultIo,
): void {
  const target = resolveSettingsPath(env, home);
  const tmp = `${target}.${io.randomUUID()}.tmp`;
  io.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  io.renameSync(tmp, target);
}

// ============================================================================
// Change applier (kata 7pd6 — the /lunaroute TUI command's core)
// ============================================================================

/** Keys of the settings object a user can change from the TUI. */
export type SettingsKey = keyof LunarouteSettings;

/** Next state for one setting: toggles flip, the search provider advances
 * through SEARCH_PROVIDERS (cyclically). Pure — returns a new object. */
export function applySettingChange(settings: LunarouteSettings, key: SettingsKey): LunarouteSettings {
  switch (key) {
    case "searchProvider": {
      const i = SEARCH_PROVIDERS.indexOf(settings.searchProvider);
      return { ...settings, searchProvider: SEARCH_PROVIDERS[(i + 1) % SEARCH_PROVIDERS.length] };
    }
    case "mcp":
      return { ...settings, mcp: settings.mcp === "on" ? "off" : "on" };
    case "webTools":
      return { ...settings, webTools: settings.webTools === "on" ? "off" : "on" };
    case "imageTools":
      return { ...settings, imageTools: settings.imageTools === "on" ? "off" : "on" };
    case "convertTools":
      return { ...settings, convertTools: settings.convertTools === "on" ? "off" : "on" };
  }
}

/** Write-first applier: persist the file, THEN trigger the instance reload.
 * A write failure throws before any PATCH — the file is the source of truth,
 * so a change that was not persisted must never look applied. */
export async function saveSettingsAndApply(
  env: NodeJS.ProcessEnv,
  home: string,
  client: SettingsApplyClient,
  settings: LunarouteSettings,
  io: SettingsIo = defaultIo,
): Promise<SettingsApplyOutcome> {
  writeSettings(env, home, settings, io);
  return applySettingsViaReload(client);
}

// ============================================================================
// Decisions (pure)
// ============================================================================

/** Web tools enabled? The env escape hatch wins; the file is the user knob. */
export function webToolsEnabled(env: NodeJS.ProcessEnv, settings: LunarouteSettings): boolean {
  const v = env[LUNAROUTE_ENV_WEB_TOOLS];
  if (v === "off" || v === "0" || v === "false") return false;
  return settings.webTools === "on";
}

/** Image tools enabled? Same contract as webToolsEnabled — the env escape
 * hatch only ever disables; the file is the user knob (kata e30g consumer
 * lands with kata 5715). */
export function imageToolsEnabled(env: NodeJS.ProcessEnv, settings: LunarouteSettings): boolean {
  const v = env[LUNAROUTE_ENV_IMAGE_TOOLS];
  if (v === "off" || v === "0" || v === "false") return false;
  return settings.imageTools === "on";
}

/** Convert tools enabled? Same contract (kata zpzt consumer lands with gv7t). */
export function convertToolsEnabled(env: NodeJS.ProcessEnv, settings: LunarouteSettings): boolean {
  const v = env[LUNAROUTE_ENV_CONVERT_TOOLS];
  if (v === "off" || v === "0" || v === "false") return false;
  return settings.convertTools === "on";
}

/** MCP registration enabled? File-only (no env hatch, pi parity). Consumed by
 * the MCP reconciler gate in index.ts. */
export function mcpEnabled(settings: LunarouteSettings): boolean {
  return settings.mcp === "on";
}

/** Provider to pass to the MCP web_search tool; undefined = server default. */
export function resolveSearchProvider(settings: LunarouteSettings): ConcreteSearchProvider | undefined {
  return settings.searchProvider === "server" ? undefined : settings.searchProvider;
}

// ============================================================================
// Live apply (spike-verified — docs/settings-live-apply-spike.md)
// ============================================================================

/** Structural slice of the OpenCode SDK client needed to trigger a reload. */
export type SettingsApplyClient = {
  config: {
    get(): Promise<{ data?: { model?: string }; model?: string }>;
    update(body: { config: { model: string } }): Promise<unknown>;
  };
};

export type SettingsApplyOutcome = "patched" | "skipped-no-model";

/** Trigger the instance reload that makes registration-time gates (web tools,
 * MCP) re-evaluate against the fresh settings file: a config PATCH marks the
 * instance for disposal, and the next instance use re-runs the plugin factory
 * + config hook (spike A/B/A-verified — the tool map rebuilds per instance).
 * The PATCH re-writes the CURRENT default model — idempotent, never changes
 * user state. With no default model set there is nothing idempotent to write,
 * so this skips (the reload then happens on the next natural instance);
 * callers wanting a forced reload in that case must supply their own patch
 * body. Throws on client failure — callers handle. */
export async function applySettingsViaReload(client: SettingsApplyClient): Promise<SettingsApplyOutcome> {
  const fetched = await client.config.get();
  const model = fetched?.data?.model ?? fetched?.model;
  if (!model) return "skipped-no-model";
  await client.config.update({ config: { model } });
  return "patched";
}
