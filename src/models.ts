import { buildAttributionHeaders, mapCatalog, type MappedModel } from "./lunaroute.js";

export type CatalogResult = { models: MappedModel[]; skipped: { id: string; reason: string }[] } | { error: string };

/** Fetch + map the gateway catalog. The v2 provider transform replays
 * captured state, so no cross-invocation memo is needed (v1's config hook ran
 * several times per process; the v2 setup/credential-event paths fetch when
 * there is a reason to). */
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
    if (typeof body !== "object" || body === null || !Array.isArray((body as { data?: unknown }).data)) {
      return { error: "malformed catalog body" };
    }
    return mapCatalog((body as { data: unknown[] }).data);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
