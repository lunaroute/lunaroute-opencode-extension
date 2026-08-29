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
