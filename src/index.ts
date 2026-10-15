import { homedir } from "node:os";
import { Plugin } from "@opencode/plugin";
import {
  buildAttributionHeaders,
  defaultModelId,
  generateSessionId,
  LUNAROUTE_PROVIDER,
  resolveMcpUrl,
  resolveRoutingUrl,
  type MappedModel,
} from "./lunaroute.js";
import { fetchCatalog } from "./models.js";
import { createLunarouteProvider, type ProviderCtxLike } from "./provider.js";
import {
  createCredentialReader,
  createLunarouteIntegration,
  type ConnectionCtxLike,
  type IntegrationCtxLike,
} from "./integration.js";
import { createLunarouteMcp, type AuthResolution, type McpCtxLike } from "./mcp.js";
import { resolveWire } from "./wire.js";
import {
  convertToolsEnabled,
  imageToolsEnabled,
  mcpEnabled,
  readSettings,
  webToolsEnabled,
} from "./settings.js";
import { buildWebToolMap, listServerToolDescriptors } from "./web-tools.js";
import { buildImageToolMap } from "./image-tools.js";
import { buildConvertToolMap } from "./convert-tools.js";
import { toV2Result, type ToolDefinition as ToolDefinitionLike } from "./tool-api.js";

/**
 * LunaRoute plugin, OpenCode v2 (kata 4qqn).
 *
 * The v1 entry returned hooks from a function; v2 default-exports
 * `Plugin.define({ id, setup })` with transforms/hooks registered on the
 * context. Everything async happens here in setup (or on credential events);
 * the transforms themselves are synchronous replays over captured state.
 * v2 owns the credential store, so the key comes from the provider's
 * integration connection instead of the v1 auth.json reads.
 */

export type PluginLog = (level: "info" | "warn", message: string) => void;

/** Tool map entry shape as the v2 editor takes it; the tool modules produce
 * v1-shaped results through src/tool-api.ts and the transform converts them. */
type ToolInfoLike = ToolDefinitionLike;

export default Plugin.define({
  id: "lunaroute",
  async setup(ctx) {
    const env = process.env;
    const home = homedir();
    const sessionId = generateSessionId();
    const routingUrl = resolveRoutingUrl(env);
    const mcpUrl = resolveMcpUrl(env);
    const wire = resolveWire(env);

    // v1's client.app.log sink is gone in v2; console output is the fallback
    // (verified against the server log during the port spike).
    const log: PluginLog = (level, message) => {
      if (level === "warn") console.warn(message);
      else console.log(message);
    };
    if (wire.warning) log("warn", wire.warning);

    let lastSettingsWarnReason: string | undefined;
    const onInvalidSettings = (reason: string): void => {
      if (reason === lastSettingsWarnReason) return;
      lastSettingsWarnReason = reason;
      log("warn", `LunaRoute: ${reason}`);
    };
    const settingsNow = () => readSettings(env, home, undefined, onInvalidSettings);

    const reader = createCredentialReader(ctx as unknown as ConnectionCtxLike);
    const resolveAuth = async (): Promise<AuthResolution> => {
      const key = await reader();
      return key ? { state: "valid", key } : { state: "logged-out" };
    };

    // --- Provider + catalog -------------------------------------------------
    const provider = createLunarouteProvider({
      routingUrl,
      wirePackage: wire.package,
      resolveKey: reader,
      fetchCatalog: (url, key) => fetchCatalog(url, key, sessionId),
      log,
    });
    await provider.register(ctx as unknown as ProviderCtxLike);

    // Post-login default-model pick (v1's postLoginRefresh, without the config
    // file write): set once when no default is selected, replayed by
    // model.reload() after each catalog refresh.
    let catalogModels: MappedModel[] = provider.getModels();
    await ctx.model.transform((editor) => {
      if (catalogModels.length === 0) return;
      if (editor.default.get()) return;
      const id = defaultModelId(catalogModels);
      if (!id) return;
      editor.default.set(LUNAROUTE_PROVIDER as never, id as never);
      log("info", `LunaRoute: set ${LUNAROUTE_PROVIDER}/${id} as the default model (change with /models)`);
    });

    // --- Integration (login methods) ----------------------------------------
    await createLunarouteIntegration({ env, log }).register(ctx as unknown as IntegrationCtxLike);

    // --- Attribution headers (chat.headers replacement) ----------------------
    await ctx.session.hook(
      "model.request",
      (event) => {
        Object.assign(event.headers, buildAttributionHeaders(sessionId));
      },
      { providerID: LUNAROUTE_PROVIDER },
    );

    // --- Hosted MCP ----------------------------------------------------------
    const mcp = createLunarouteMcp({
      mcpUrl,
      sessionId,
      log,
      enabled: () => mcpEnabled(settingsNow()),
    });
    await mcp.register(ctx as unknown as McpCtxLike, await reader());

    // --- First-class tools (web / image / convert) ---------------------------
    let toolDefs: Record<string, ToolInfoLike> = {};
    const buildTools = async (): Promise<Record<string, ToolInfoLike>> => {
      const resolution = await resolveAuth();
      if (resolution.state !== "valid") return {};
      const settings = settingsNow();
      const wantWeb = webToolsEnabled(env, settings);
      const wantImage = imageToolsEnabled(env, settings);
      const wantConvert = convertToolsEnabled(env, settings);
      if (!wantWeb && !wantImage && !wantConvert) return {};
      let descriptors: { name: string; inputSchema?: unknown }[];
      try {
        descriptors = await listServerToolDescriptors({ url: mcpUrl, key: resolution.key, sessionId });
      } catch (err) {
        log(
          "warn",
          `LunaRoute: first-class tools not registered (tools/list failed: ${err instanceof Error ? err.message : String(err)})`,
        );
        return {};
      }
      const [web, image, convert] = await Promise.all([
        wantWeb
          ? buildWebToolMap({
              env,
              mcpUrl,
              sessionId,
              log,
              resolveKey: resolveAuth,
              readSettingsNow: settingsNow,
              descriptors,
            })
          : Promise.resolve({}),
        wantImage
          ? buildImageToolMap({
              env,
              home,
              mcpUrl,
              sessionId,
              log,
              resolveKey: resolveAuth,
              readSettingsNow: settingsNow,
              descriptors,
            })
          : Promise.resolve({}),
        wantConvert
          ? buildConvertToolMap({
              env,
              home,
              mcpUrl,
              sessionId,
              log,
              resolveKey: resolveAuth,
              readSettingsNow: settingsNow,
              descriptors,
            })
          : Promise.resolve({}),
      ]);
      return { ...web, ...image, ...convert } as unknown as Record<string, ToolInfoLike>;
    };
    toolDefs = await buildTools();
    await ctx.tool.transform((editor) => {
      for (const [name, def] of Object.entries(toolDefs)) {
        editor.add({
          name,
          description: def.description,
          input: def.input,
          execute: async (input: unknown, context: { signal: AbortSignal }) =>
            toV2Result(await def.execute(input, context)),
        } as never);
      }
    });

    // --- Credential lifecycle: refresh catalog, MCP, tools, default model ----
    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type !== "credential.updated" && event.type !== "credential.switched") continue;
        const data = event.data as { integrationID?: string } | undefined;
        if (data?.integrationID !== undefined && data.integrationID !== LUNAROUTE_PROVIDER) continue;
        const key = await reader();
        await provider.refresh(ctx as unknown as ProviderCtxLike);
        catalogModels = provider.getModels();
        await ctx.model.reload();
        await mcp.refresh(ctx as unknown as McpCtxLike, key);
        toolDefs = await buildTools();
        await ctx.tool.reload();
      }
    })();

    return () => controller.abort();
  },
});
