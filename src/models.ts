import { buildAttributionHeaders, LUNAROUTE_PROVIDER, mapCatalog, type MappedModel } from "./lunaroute.js";

export type ConfigLike = Record<string, unknown>;

export type CatalogResult = { models: MappedModel[]; skipped: { id: string; reason: string }[] } | { error: string };

export async function fetchCatalog(
  routingUrl: string,
  key: string,
  sessionId: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<CatalogResult> {
  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(`${routingUrl}/models`, {
      headers: { Authorization: `Bearer ${key}`, ...buildAttributionHeaders(sessionId) },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = await res.json();
    if (typeof body !== "object" || body === null || !Array.isArray((body as { data?: unknown }).data)) return { error: "malformed catalog body" };
    return mapCatalog((body as { data: unknown[] }).data);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export type ProviderModel = Record<string, unknown>;

export function toProviderModels(models: MappedModel[], baseUrl: string): Record<string, ProviderModel> {
  const out: Record<string, ProviderModel> = {};
  for (const m of models) {
    out[m.id] = {
      id: m.id,
      name: m.name,
      providerID: LUNAROUTE_PROVIDER,
      family: m.id.split("/").pop()?.split("-")[0] ?? m.id,
      release_date: "",
      attachment: m.attachment,
      reasoning: m.reasoning,
      temperature: true,
      tool_call: m.tool_call,
      modalities: { input: m.modalitiesInput, output: ["text"] },
      api: { id: m.id, url: baseUrl, npm: "@ai-sdk/openai-compatible" },
      capabilities: {
        temperature: true, reasoning: m.reasoning, attachment: m.attachment, toolcall: m.tool_call,
        input: { text: true, image: m.attachment, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: m.limitContext, output: m.limitOutput },
      options: {},
      headers: {},
      status: "active",
      variants: m.variants,
    };
  }
  return out;
}

export function injectProviderStub(cfg: ConfigLike, routingUrl: string): void {
  const providers = (cfg.provider ?? {}) as Record<string, Record<string, unknown>>;
  cfg.provider = providers;
  const existing = providers[LUNAROUTE_PROVIDER];
  const existingOptions = (existing?.options ?? {}) as Record<string, unknown>;
  providers[LUNAROUTE_PROVIDER] = {
    ...existing,
    name: existing?.name ?? "LunaRoute",
    npm: existing?.npm ?? "@ai-sdk/openai-compatible",
    options: { ...existingOptions, baseURL: existingOptions.baseURL ?? routingUrl },
  };
}

/** Catalog is the source of truth when logged in: fetched models replace provider.lunaroute.models. */
export function injectModels(cfg: ConfigLike, models: MappedModel[], baseUrl: string): void {
  const providers = (cfg.provider ?? {}) as Record<string, Record<string, unknown>>;
  cfg.provider = providers;
  const provider = providers[LUNAROUTE_PROVIDER] ?? {};
  provider.models = toProviderModels(models, baseUrl);
  providers[LUNAROUTE_PROVIDER] = provider;
}

/** Per-process per-credential memo: concurrent callers share one in-flight fetch;
 * a SUCCESSFUL result is reused for later same-key calls (config hook runs multiple
 * times per process); a FAILED result is never cached — the next call retries. */
export function createCatalogMemo(fetchFor: (key: string) => Promise<CatalogResult>): (key: string) => Promise<CatalogResult> {
  const cache = new Map<string, Promise<CatalogResult>>();
  return (k: string) => {
    let entry = cache.get(k);
    if (!entry) {
      entry = fetchFor(k).then(
        (result) => {
          if ("error" in result) cache.delete(k); // failure: do not cache
          return result;
        },
        (err) => {
          cache.delete(k);
          throw err;
        },
      );
      cache.set(k, entry);
    }
    return entry;
  };
}
