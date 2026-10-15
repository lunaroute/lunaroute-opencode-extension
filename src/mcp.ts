import { buildAttributionHeaders, LUNAROUTE_PROVIDER } from "./lunaroute.js";

/**
 * v2 MCP registration (kata 4qqn) — the `config` hook's MCP contributor
 * replacement.
 *
 * v2 transforms are replayed declarative state edits, so the v1 reconciler's
 * machinery (fingerprint memory, logout cleanup, managed-shape detection) has
 * no purpose: when there is no credential the transform simply does not place
 * the entry, and a registry rebuild removes it. What survives is the defer
 * rule (kata h4j3, pi 1z1s parity): any other server pointing at the hosted
 * URL wins, and a user-defined `lunaroute` entry is never overwritten.
 */

export type McpLog = (level: "info" | "warn", message: string) => void;

/** Credential tri-state kept for the tool gates: v2 resolves the key from the
 * integration connection, and callers map a missing/failed lookup onto the
 * same shape the v1 tool modules already understand (their skip + message
 * logic is unchanged). */
export type AuthResolution =
  | { state: "valid"; key: string }
  | { state: "logged-out" }
  | { state: "indeterminate"; reason: string };

/** v2 server config slice; `disabled` replaces v1's `enabled`. */
export type McpServerLike = {
  type: "remote";
  url: string;
  headers: Record<string, string>;
  oauth: false;
  disabled: boolean;
};

export type McpEditorLike = {
  list(): readonly (readonly [string, { url?: unknown; disabled?: unknown }])[];
  get(name: string): { url?: unknown } | undefined;
  set(name: string, config: McpServerLike): void;
};

export type McpCtxLike = {
  mcp: {
    transform(callback: (editor: McpEditorLike) => void): Promise<unknown>;
    reload(): Promise<void>;
  };
};

/** Normalized URL identity for the defer rule: scheme + host (WHATWG
 * normalization lowercases it) + pathname without trailing slashes. */
export function normalizedUrlIdentity(value: unknown): string | undefined {
  const url = typeof value === "object" && value !== null ? (value as { url?: unknown }).url : undefined;
  if (typeof url !== "string" || url === "") return undefined;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

export function buildMcpServer(key: string, mcpUrl: string, sessionId: string): McpServerLike {
  return {
    type: "remote",
    url: mcpUrl,
    headers: { "LUNAROUTE-API-KEY": key, ...buildAttributionHeaders(sessionId) },
    oauth: false,
    disabled: false,
  };
}

export function createLunarouteMcp(opts: {
  mcpUrl: string;
  sessionId: string;
  log: McpLog;
}): {
  register(ctx: McpCtxLike, key: string | undefined): Promise<void>;
  refresh(ctx: McpCtxLike, key: string | undefined): Promise<void>;
} {
  let key: string | undefined;
  let deferNoticeShown = false;

  const apply = async (ctx: McpCtxLike): Promise<void> => {
    await ctx.mcp.transform((editor) => {
      if (!key) return; // logged out: registry rebuild drops our entry
      const target = normalizedUrlIdentity({ url: opts.mcpUrl });
      for (const [name, entry] of editor.list()) {
        if (name === LUNAROUTE_PROVIDER) continue;
        if (target && normalizedUrlIdentity(entry) === target) {
          if (!deferNoticeShown) {
            deferNoticeShown = true;
            opts.log(
              "info",
              `LunaRoute: your mcp.${name} server points at the hosted LunaRoute MCP URL — deferring to it (its key is static; rotation means editing it or removing it and letting the plugin re-register)`,
            );
          }
          return;
        }
      }
      // User-defined exact-name entry: leave it, same as v1.
      if (editor.get(LUNAROUTE_PROVIDER) !== undefined) {
        opts.log("info", "LunaRoute: user-defined mcp.lunaroute in effect; rotate by editing it or removing it");
        return;
      }
      editor.set(LUNAROUTE_PROVIDER, buildMcpServer(key, opts.mcpUrl, opts.sessionId));
    });
  };

  return {
    register: async (ctx, initialKey) => {
      key = initialKey;
      await apply(ctx);
    },
    refresh: async (ctx, nextKey) => {
      key = nextKey;
      await ctx.mcp.reload();
    },
  };
}
