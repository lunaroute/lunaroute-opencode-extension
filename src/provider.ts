import { Provider } from "@opencode/plugin";
import type { CatalogResult } from "./models.js";
import type { MappedModel } from "./lunaroute.js";
import { LUNAROUTE_PROVIDER } from "./lunaroute.js";
import { toModelInfo } from "./model-info.js";
import type { WirePackage } from "./wire.js";

/**
 * v2 provider registration (kata 4qqn). Replaces the v1 `config` hook's
 * provider stub + model injection.
 *
 * The v2 transform callback is synchronous by contract, so every async input
 * (credential resolution, catalog fetch) happens here, outside the callback,
 * and the transform reads the captured `state`. Callers replay it with
 * `provider.reload()` after a credential/catalog change.
 */

export type ProviderLog = (level: "info" | "warn", message: string) => void;

/** Structural editor/context slices so tests and non-OpenCode callers stay
 * independent of the plugin runtime types; the real Context is cast at the
 * wiring site in index.ts. */
export type ProviderEditorLike = {
  get(id: string): { provider?: { settings?: { baseURL?: unknown } } } | undefined;
  add(input: { info: Record<string, unknown>; models: Record<string, unknown>[] }): void;
};

export type ProviderCtxLike = {
  provider: {
    transform(callback: (editor: ProviderEditorLike) => void): Promise<unknown>;
    reload(): Promise<void>;
  };
};

export type ProviderDeps = {
  routingUrl: string;
  wirePackage: WirePackage;
  resolveKey: () => Promise<string | undefined>;
  fetchCatalog: (url: string, key: string) => Promise<CatalogResult>;
  log: ProviderLog;
};

export function createLunarouteProvider(deps: ProviderDeps): {
  register(ctx: ProviderCtxLike): Promise<void>;
  refresh(ctx: ProviderCtxLike): Promise<void>;
  /** Last successfully loaded catalog — read by the default-model picker. */
  getModels(): MappedModel[];
} {
  // Last catalog that loaded successfully. A failed refresh keeps it (v1's
  // availability policy: never wipe models the user can still use).
  let models: MappedModel[] = [];

  const load = async (): Promise<void> => {
    let key: string | undefined;
    try {
      key = await deps.resolveKey();
    } catch (err) {
      deps.log("warn", `LunaRoute: credential lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!key) {
      models = [];
      return;
    }
    const result = await deps.fetchCatalog(deps.routingUrl, key);
    if ("error" in result) {
      deps.log("warn", `LunaRoute: catalog fetch failed: ${result.error}`);
      return;
    }
    for (const skipped of result.skipped) {
      deps.log("warn", `LunaRoute: skipped catalog entry "${skipped.id}": ${skipped.reason}`);
    }
    models = result.models;
  };

  const buildInfo = (editor: ProviderEditorLike): Record<string, unknown> => {
    // User-pinned baseURL (opencode.json providers.lunaroute.settings.baseURL)
    // wins over the env/resolved default — v1's "Base URL precedence".
    const pinned = editor.get(LUNAROUTE_PROVIDER)?.provider?.settings?.baseURL;
    const baseURL = typeof pinned === "string" && pinned ? pinned : deps.routingUrl;
    return {
      ...Provider.Info.empty(LUNAROUTE_PROVIDER as Provider.ID),
      name: "LunaRoute",
      activation: "auto",
      package: deps.wirePackage,
      integrationID: LUNAROUTE_PROVIDER,
      settings: { baseURL },
    } as unknown as Record<string, unknown>;
  };

  const apply = async (ctx: ProviderCtxLike): Promise<void> => {
    await ctx.provider.transform((editor) => {
      editor.add({
        info: buildInfo(editor),
        models: models.map((m) => toModelInfo(m, LUNAROUTE_PROVIDER)) as unknown as Record<string, unknown>[],
      });
    });
  };

  return {
    register: async (ctx) => {
      await load();
      await apply(ctx);
    },
    refresh: async (ctx) => {
      await load();
      await ctx.provider.reload();
    },
    getModels: () => models,
  };
}
