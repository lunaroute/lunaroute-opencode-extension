import { readFileSync } from "node:fs";
import { join } from "node:path";

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

/** Env escape hatch — only ever disables (off|0|false), mirroring pi. */
export const LUNAROUTE_ENV_WEB_TOOLS = "LUNAROUTE_WEB_TOOLS";

// ============================================================================
// IO (injectable for tests; default = node:fs)
// ============================================================================

export interface SettingsIo {
  readFileSync(path: string): string;
}

const defaultIo: SettingsIo = { readFileSync: (path) => readFileSync(path, "utf8") };

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

/** Read settings, tolerantly: missing file, invalid JSON, or invalid values
 * fall back per key. Extra keys are ignored. Never throws. */
export function readSettings(env: NodeJS.ProcessEnv, home: string, io: SettingsIo = defaultIo): LunarouteSettings {
  let raw: string;
  try {
    raw = io.readFileSync(resolveSettingsPath(env, home));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
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

/** Web tools enabled? The env escape hatch wins; the file is the user knob. */
export function webToolsEnabled(env: NodeJS.ProcessEnv, settings: LunarouteSettings): boolean {
  const v = env[LUNAROUTE_ENV_WEB_TOOLS];
  if (v === "off" || v === "0" || v === "false") return false;
  return settings.webTools === "on";
}

/** Provider to pass to the MCP web_search tool; undefined = server default. */
export function resolveSearchProvider(settings: LunarouteSettings): ConcreteSearchProvider | undefined {
  return settings.searchProvider === "server" ? undefined : settings.searchProvider;
}
