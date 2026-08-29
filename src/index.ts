import { homedir } from "node:os";
import type { AuthHook, Plugin } from "@opencode-ai/plugin";
import {
  buildAttributionHeaders,
  defaultModelId,
  generateSessionId,
  LUNAROUTE_PROVIDER,
  resolveMcpUrl,
  resolveRoutingUrl,
} from "./lunaroute.js";
import { createLunarouteAuth } from "./login.js";
import { createCatalogMemo, fetchCatalog, injectModels, injectProviderStub } from "./models.js";
import { createMcpReconciler, resolveAuthState, resolveAuthStorePath, type AuthStoreFS } from "./mcp.js";

export type PluginLog = (level: "info" | "warn", message: string) => void;

/**
 * Structural slice of the OpenCode SDK client used by the post-login
 * default-model pick. The real client carries far more surface; we only
 * depend on `config.get()` (→ `{ data }`) and `config.update()` (deep-merge
 * PATCH of the payload into the instance `config.json` — spike-verified).
 */
export type TestClient = {
  config: {
    // get() may return the wrapped `{ data }` shape or the flat config object
    // directly — not spike-verified which, so the read is shape-tolerant.
    get(): Promise<{ data?: { model?: string }; model?: string }>;
    update(body: { config: { model: string } }): Promise<unknown>;
  };
};

/**
 * Test doubles for the config hook's second argument. OpenCode itself calls
 * `config(input)` with one argument; the optional runtime param lets tests
 * (and only tests) pin the auth-store path, the auth-store FS, and the client.
 */
export type PluginRuntime = {
  storeKey?: string;
  fs?: AuthStoreFS;
  client?: TestClient;
};

export type PluginDeps = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  log?: PluginLog;
  client?: TestClient;
};

export type LunarouteHooks = {
  config: (cfg: Record<string, unknown>, runtime?: PluginRuntime) => Promise<void>;
  auth: AuthHook;
  "chat.headers": (
    req: { provider?: { info?: { id?: string } } },
    output: { headers: Record<string, string> },
  ) => Promise<void>;
  dispose: () => Promise<void>;
};

export type LunaroutePlugin = (input: { client?: TestClient }, _options?: unknown) => Promise<LunarouteHooks>;

/**
 * Build the LunaRoute plugin. One call per process: the session id, catalog
 * memo, MCP reconciler state, and the first-run hint flag are shared by every
 * invocation of the returned function (OpenCode may invoke it per instance).
 */
export function createLunaroutePlugin(deps: PluginDeps = {}): LunaroutePlugin {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const sessionId = generateSessionId();
  const routingUrl = resolveRoutingUrl(env);
  const mcpUrl = resolveMcpUrl(env);
  const log: PluginLog = deps.log ?? (() => {});
  const reconciler = createMcpReconciler(mcpUrl, log, sessionId);
  const catalogMemo = createCatalogMemo((key) => fetchCatalog(routingUrl, key, sessionId));
  let firstRunHintShown = false;

  return async (input) => {
    const clientOf = (runtime?: PluginRuntime): TestClient | undefined =>
      runtime?.client ?? deps.client ?? input?.client;

    /** Resolve the current default model from either SDK get() shape (wrapped or flat). */
    const currentModelOf = (cfg: { data?: { model?: string }; model?: string } | undefined | null): string | undefined =>
      cfg?.data?.model ?? cfg?.model;

    /**
     * Post-login default-model pick. The ONLY config write the plugin ever
     * makes: exactly `{ model }` (never mcp, never keys) — config.update
     * deep-merges and persists to the instance config.json (spike-verified).
     * The update marks the instance for disposal; on reload the config hook
     * re-runs (spike gate (a)) and re-injects models + MCP with the fresh key.
     */
    const postLoginRefresh = async (key: string, runtime?: PluginRuntime): Promise<void> => {
      try {
        const client = clientOf(runtime);
        if (!client) return;
        const current = currentModelOf(await client.config.get());
        if (current) return;
        const catalog = await catalogMemo(key);
        if ("error" in catalog) {
          log("warn", `LunaRoute: post-login catalog fetch failed: ${catalog.error}`);
          return;
        }
        if (!catalog.models.length) return;
        const id = defaultModelId(catalog.models);
        if (!id) return;
        const fresh = currentModelOf(await client.config.get()); // re-read guard: a concurrent selection wins
        if (fresh) return;
        await client.config.update({ config: { model: `${LUNAROUTE_PROVIDER}/${id}` } });
      } catch (err) {
        log("warn", `LunaRoute: post-login default-model pick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    return {
      config: async (cfg: Record<string, unknown>, runtime?: PluginRuntime) => {
        // Contributor 1: provider stub — always lands, individually isolated.
        try {
          injectProviderStub(cfg, routingUrl);
        } catch (err) {
          log("warn", `LunaRoute: provider stub injection failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        // One auth resolution feeds contributors 2 (models) and 3 (MCP).
        try {
          const storeKey = runtime?.storeKey ?? resolveAuthStorePath(env, home);
          const resolution = await resolveAuthState(storeKey, runtime?.fs);
          try {
            if (resolution.state === "valid") {
              const result = await catalogMemo(resolution.key);
              if ("error" in result) {
                log("warn", `LunaRoute: catalog fetch failed: ${result.error}`);
              } else {
                for (const s of result.skipped) log("warn", `LunaRoute: skipped catalog entry "${s.id}": ${s.reason}`);
                if (result.skipped.length && !result.models.length) {
                  log("warn", `LunaRoute: catalog had ${result.skipped.length} invalid entries, all skipped`);
                }
                injectModels(cfg, result.models, routingUrl);
              }
            } else if (resolution.state === "logged-out" && !firstRunHintShown) {
              firstRunHintShown = true;
              log("info", "Run /connect and choose LunaRoute to start using LunaRoute.");
            }
            // logged-out / indeterminate: leave any existing models untouched
            // (fail-safe retention per the spec's availability policy).
          } catch (err) {
            log("warn", `LunaRoute: model injection failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          try {
            reconciler.reconcile(cfg, resolution, storeKey);
          } catch (err) {
            log("warn", `LunaRoute: MCP injection failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } catch (err) {
          log("warn", `LunaRoute: auth resolution failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      auth: createLunarouteAuth({
        env,
        log,
        sessionId,
        onLoginSuccess: (key) => {
          void postLoginRefresh(key);
        },
      }),
      "chat.headers": async (req, output) => {
        if (req.provider?.info?.id === LUNAROUTE_PROVIDER) {
          Object.assign(output.headers, buildAttributionHeaders(sessionId));
        }
      },
      dispose: async () => {},
    };
  };
}

// The plugin package's `Plugin`/`Hooks` types are richer than our structural
// slice; the runtime shapes are compatible (spike-verified against a packed
// tarball in a real OpenCode). One targeted cast, at the default export only —
// never inside the modules.
const lunaroutePlugin: Plugin = createLunaroutePlugin() as unknown as Plugin;
export default lunaroutePlugin;
