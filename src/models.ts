import { buildAttributionHeaders, mapCatalog, type MappedModel } from "./lunaroute.js";

export type CatalogResult = { models: MappedModel[]; skipped: { id: string; reason: string }[] } | { error: string };

/** Fetch budget (kata xn2w): one retry, 1 s apart. A transport failure or a 5xx/429 is
 * worth one more try; a 4xx or an unparseable body (captive portal) is not, and a hung
 * endpoint cannot heal inside the budget — two attempts cap a location's load at ~11 s. */
const ATTEMPTS = 2;
const RETRY_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One request. `retryable` marks the failures a second attempt could plausibly fix. */
async function attemptCatalog(
  doFetch: typeof fetch,
  routingUrl: string,
  key: string,
  sessionId: string,
  timeoutMs: number,
): Promise<{ result: CatalogResult; retryable: boolean }> {
  let res: Response;
  try {
    res = await doFetch(`${routingUrl}/models`, {
      headers: { Authorization: `Bearer ${key}`, ...buildAttributionHeaders(sessionId) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { result: { error: err instanceof Error ? err.message : String(err) }, retryable: true };
  }
  if (!res.ok) return { result: { error: `HTTP ${res.status}` }, retryable: res.status >= 500 || res.status === 429 };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // A body that does not parse is a captive portal or a proxy page, not a blip.
    return { result: { error: "malformed catalog body" }, retryable: false };
  }
  if (typeof body !== "object" || body === null || !Array.isArray((body as { data?: unknown }).data)) {
    return { result: { error: "malformed catalog body" }, retryable: false };
  }
  return { result: mapCatalog((body as { data: unknown[] }).data), retryable: false };
}

/** Fetch + map the gateway catalog. The v2 provider transform replays
 * captured state, so no cross-invocation memo is needed (v1's config hook ran
 * several times per process; the v2 setup/credential-event paths fetch when
 * there is a reason to). Returns the LAST attempt's failure. */
export async function fetchCatalog(
  routingUrl: string,
  key: string,
  sessionId: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<CatalogResult> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let last: { error: string } = { error: "catalog fetch failed" };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { result, retryable } = await attemptCatalog(doFetch, routingUrl, key, sessionId, timeoutMs);
    if (!("error" in result)) return result;
    last = result;
    if (!retryable) return result;
    if (attempt < ATTEMPTS - 1) await sleep(RETRY_DELAY_MS);
  }
  return last;
}
