import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { buildAttributionHeaders, credentialFingerprint, isValidCredentialShape, LUNAROUTE_PROVIDER } from "./lunaroute.js";

export type AuthResolution =
  | { state: "valid"; key: string }
  | { state: "logged-out" }
  | { state: "indeterminate"; reason: string };

export type AuthStoreFS = { readFile(path: string): Promise<string> };

const defaultFS: AuthStoreFS = { readFile: (p) => fsp.readFile(p, "utf8") };

/** Lexical store path — identity is the path, not the inode (spike-verified: xdg-basedir semantics on Linux and macOS). */
export function resolveAuthStorePath(env: NodeJS.ProcessEnv, home: string): string {
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(dataHome, "opencode", "auth.json");
}

/**
 * Single read, no retry. Tri-state:
 * - valid: readable store, lunaroute entry present, credential shape-valid
 * - logged-out: readable store, lunaroute entry absent (the only durable logout signal)
 * - indeterminate: anything else — missing/unparseable/unreadable store, or a
 *   present-but-invalid record. Never treat as logout: fail-safe retention.
 */
export async function resolveAuthState(storePath: string, fs: AuthStoreFS = defaultFS): Promise<AuthResolution> {
  let raw: string;
  try {
    raw = await fs.readFile(storePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { state: "indeterminate", reason: code === "ENOENT" ? "auth store missing" : "auth store unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "indeterminate", reason: "auth store unparseable" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "indeterminate", reason: "auth store malformed" };
  }
  const entry = (parsed as Record<string, unknown>)[LUNAROUTE_PROVIDER];
  if (entry === undefined) return { state: "logged-out" };
  const record = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
  const candidate = record
    ? record.type === "api"
      ? record.key
      : record.type === "oauth"
        ? record.access
        : undefined
    : undefined;
  if (isValidCredentialShape(candidate)) return { state: "valid", key: candidate };
  return { state: "indeterminate", reason: "credential present but invalid" };
}

const EXPECTED_HEADER_NAMES = ["lunaroute-api-key", "lunaroute-agent", "x-lunaroute-session", "lunaroute-session-id"];

/**
 * Value-shape recognition: ours = remote + our URL + oauth false + enabled +
 * the same header-name set (case-insensitive, no duplicate logical names).
 * The key VALUE is ignored (it legitimately rotates). Extra non-header fields
 * are tolerated (host normalization).
 */
export function isManagedShape(entry: unknown, mcpUrl: string): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  if (e.type !== "remote" || e.url !== mcpUrl || e.oauth !== false || e.enabled !== true) return false;
  if (typeof e.headers !== "object" || e.headers === null) return false;
  const names = Object.keys(e.headers).map((k) => k.toLowerCase());
  if (names.length !== EXPECTED_HEADER_NAMES.length) return false;
  if (new Set(names).size !== names.length) return false; // duplicate logical names → malformed → user-owned
  const expected = new Set(EXPECTED_HEADER_NAMES);
  return names.every((n) => expected.has(n));
}

export type ReconcilerLog = (level: "info" | "warn", message: string) => void;

const FINGERPRINT_LIMIT = 8;

/** Case-insensitive lookup of the API-key header's value (shape matching is case-insensitive; extraction must be too). */
function apiKeyHeaderValue(entry: Record<string, unknown>): string | undefined {
  const headers = entry.headers;
  if (typeof headers !== "object" || headers === null) return undefined;
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (name.toLowerCase() === "lunaroute-api-key" && typeof value === "string") return value;
  }
  return undefined;
}

/**
 * The reconciler implements the spec's lifecycle matrix. State:
 * `Map<storeKey, Set<fingerprint>>` — storeKey is the lexically resolved
 * auth-store path; fingerprints are sha256-hex of credentials this process
 * successfully wrote into managed entries. Most recent 8 distinct credentials
 * per store; FIFO by write, re-injection refreshes position. Logout cleanup is
 * guaranteed only for those; older generations fall to the unknown-credential
 * path (retained + info log) — fail-safe, bounded memory by design.
 */
export function createMcpReconciler(mcpUrl: string, log: ReconcilerLog, sessionId: string) {
  const fingerprints = new Map<string, Set<string>>(); // storeKey → ordered fingerprints (most recent last)
  const remember = (storeKey: string, key: string): void => {
    const set = fingerprints.get(storeKey) ?? new Set<string>();
    const fp = credentialFingerprint(key);
    set.delete(fp); // refresh position
    set.add(fp);
    while (set.size > FINGERPRINT_LIMIT) set.delete(set.values().next().value as string); // evict oldest
    fingerprints.set(storeKey, set);
  };
  const knows = (storeKey: string, key: string): boolean =>
    (fingerprints.get(storeKey) ?? new Set<string>()).has(credentialFingerprint(key));

  return {
    reconcile(cfg: Record<string, unknown>, resolution: AuthResolution, storeKey: string): void {
      const mcp = (cfg.mcp ?? {}) as Record<string, unknown>; // read-only view; assigned only on write
      const existing = mcp[LUNAROUTE_PROVIDER];
      const managed = isManagedShape(existing, mcpUrl);

      if (resolution.state === "indeterminate") {
        if (existing !== undefined && managed) {
          log("warn", `LunaRoute: auth store indeterminate (${resolution.reason}); mcp.lunaroute left untouched`);
        }
        return; // silent no-op when nothing to retain
      }

      if (resolution.state === "valid") {
        if (existing !== undefined && !managed) {
          log("info", "LunaRoute: user-defined mcp.lunaroute in effect; rotate by editing it or removing it");
          return;
        }
        mcp[LUNAROUTE_PROVIDER] = {
          type: "remote",
          url: mcpUrl,
          headers: { "LUNAROUTE-API-KEY": resolution.key, ...buildAttributionHeaders(sessionId) },
          oauth: false,
          enabled: true,
        };
        cfg.mcp = mcp; // now a real write happened
        remember(storeKey, resolution.key);
        return;
      }

      // logged-out: remove only credentials we placed (fingerprint known); leave everything else.
      if (managed) {
        const key = apiKeyHeaderValue(existing as Record<string, unknown>);
        if (key !== undefined && knows(storeKey, key)) {
          delete mcp[LUNAROUTE_PROVIDER];
        } else {
          log("info", "LunaRoute: mcp.lunaroute matches the plugin shape but carries an unknown credential; left untouched");
        }
      }
    },
  };
}
