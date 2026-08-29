import { createHash, randomBytes, randomUUID } from "node:crypto";

export const LUNAROUTE_PROVIDER = "lunaroute";
export const DEVICE = "opencode";

export const DEFAULT_ROUTING_URL = "https://gw.lunaroute.com/v1";
export const DEFAULT_API_URL = "https://api.lunaroute.com";
export const DEFAULT_FRONT_URL = "https://app.lunaroute.com";
export const DEFAULT_MCP_URL = "https://mcp.lunaroute.com/mcp";

export function resolveRoutingUrl(env: NodeJS.ProcessEnv): string { return env.LUNAROUTE_ROUTING_URL || DEFAULT_ROUTING_URL; }
export function resolveApiUrl(env: NodeJS.ProcessEnv): string { return env.LUNAROUTE_API_URL || DEFAULT_API_URL; }
export function resolveFrontUrl(env: NodeJS.ProcessEnv): string { return env.LUNAROUTE_FRONT_URL || DEFAULT_FRONT_URL; }
export function resolveMcpUrl(env: NodeJS.ProcessEnv): string { return env.LUNAROUTE_MCP_URL || DEFAULT_MCP_URL; }

export function buildAttributionHeaders(sessionId: string): Record<string, string> {
  return {
    "lunaroute-agent": DEVICE,
    "x-lunaroute-session": sessionId,
    "lunaroute-session-id": sessionId,
  };
}

export function generateSessionId(
  randomUuid: () => string = randomUUID,
  now: () => number = Date.now,
  random: () => number = Math.random,
): string {
  try { return randomUuid(); }
  catch { return `lunaroute-opencode-${now()}-${random().toString(36).slice(2, 10)}`; }
}

// PKCE — hex sha256 to match LunaRoute's Go backend (sha256hexStr).
export function generatePkceVerifier(): string { return randomBytes(32).toString("hex"); }
export function computePkceChallenge(verifier: string): string { return createHash("sha256").update(verifier).digest("hex"); }
export function generateState(): string { return randomBytes(16).toString("hex"); }

export function buildDeviceAuthUrl(frontUrl: string, port: number, state: string, challenge: string): string {
  const params = new URLSearchParams({ port: String(port), state, challenge });
  return `${frontUrl}/device-auth/${DEVICE}?${params.toString()}`;
}

export function parseCallbackQuery(callbackUrl: string): { code: string; state: string } {
  const url = new URL(callbackUrl, "http://127.0.0.1");
  return { code: url.searchParams.get("code") ?? "", state: url.searchParams.get("state") ?? "" };
}

export type ExchangeRequest = { code: string; verifier: string; label: string };
export type ExchangeResponse = {
  full_key: string; org_id: string; user_email: string;
  routing_url?: string; api_url?: string;
};
export function buildExchangeBody(req: ExchangeRequest): string { return JSON.stringify(req); }

export const MAX_CREDENTIAL_LENGTH = 512;
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
export function isValidCredentialShape(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key.length <= MAX_CREDENTIAL_LENGTH && PRINTABLE_ASCII.test(key);
}

export function credentialFingerprint(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export const DEFAULT_CONTEXT_LIMIT = 128000;
export const DEFAULT_OUTPUT_LIMIT = 4096;
export const MAX_CONTEXT_LIMIT = 100_000_000;
export const MAX_OUTPUT_LIMIT = 10_000_000;

function validLimit(v: unknown, max: number): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= max ? v : undefined;
}

export type MappedModel = {
  id: string; name: string; reasoning: boolean; tool_call: boolean; attachment: boolean;
  limitContext: number; limitOutput: number; modalitiesInput: ("text" | "image")[];
  variants: Record<string, { reasoningEffort: string }>;
};

export type CatalogMappingResult = { ok: true; model: MappedModel } | { ok: false; reason: string };

// Catalog input is untrusted remote input — validation never trusts the source.
export function mapCatalogEntry(entry: unknown): CatalogMappingResult {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { ok: false, reason: "not an object" };
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== "string" || e.id.length === 0) return { ok: false, reason: "missing or invalid id" };
  const caps = (typeof e.capabilities === "object" && e.capabilities !== null && !Array.isArray(e.capabilities) ? e.capabilities : {}) as Record<string, unknown>;
  const reasoning = caps.reasoning === true;
  const vision = caps.vision === true;
  return {
    ok: true,
    model: {
      id: e.id,
      name: typeof e.display_name === "string" && e.display_name.length > 0 ? e.display_name : e.id,
      reasoning,
      tool_call: caps.tools !== false,
      attachment: vision,
      limitContext: validLimit(e.context_window, MAX_CONTEXT_LIMIT) ?? DEFAULT_CONTEXT_LIMIT,
      limitOutput: validLimit(e.max_output_tokens, MAX_OUTPUT_LIMIT) ?? DEFAULT_OUTPUT_LIMIT,
      modalitiesInput: vision ? ["text", "image"] : ["text"],
      variants: reasoning
        ? { low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" } }
        : {},
    },
  };
}

export function mapCatalog(entries: unknown[]): { models: MappedModel[]; skipped: { id: string; reason: string }[] } {
  const models: MappedModel[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = (typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).id === "string")
      ? (entry as Record<string, string>).id : "(unidentifiable entry)";
    const r = mapCatalogEntry(entry);
    if (!r.ok) { skipped.push({ id, reason: r.reason }); continue; }
    if (seen.has(r.model.id)) { skipped.push({ id: r.model.id, reason: "duplicate id" }); continue; }
    seen.add(r.model.id);
    models.push(r.model);
  }
  return { models, skipped };
}

export function defaultModelId(models: MappedModel[]): string | undefined {
  if (!models.length) return undefined;
  return [...models.map((m) => m.id)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
}
