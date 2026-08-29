import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import type { AuthHook } from "@opencode-ai/plugin";
import {
  buildAttributionHeaders,
  buildDeviceAuthUrl,
  buildExchangeBody,
  computePkceChallenge,
  generatePkceVerifier,
  generateState,
  isValidCredentialShape,
  parseCallbackQuery,
  resolveApiUrl,
  resolveFrontUrl,
  resolveRoutingUrl,
  type ExchangeRequest,
  type ExchangeResponse,
} from "./lunaroute.js";

const LOGIN_TIMEOUT_MS = 3 * 60_000;

export type LoopbackServer = {
  port: number;
  waitForCallback(): Promise<{ code: string; state: string }>;
  close(): void;
};

/** Loopback on 127.0.0.1:0 for /callback?code=&state=. Resolves once; later hits are no-ops. */
export async function startLoopbackServer(): Promise<LoopbackServer> {
  let resolveCb: (r: { code: string; state: string }) => void;
  const cbPromise = new Promise<{ code: string; state: string }>((r) => (resolveCb = r));
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<html><body><h2>LunaRoute authorized.</h2><p>You can close this tab and return to opencode.</p></body></html>",
    );
    resolveCb(parseCallbackQuery(url.toString())); // settling a settled promise is a no-op
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    waitForCallback: () => cbPromise,
    close: () => server.close(),
  };
}

export async function exchangeCode(
  apiUrl: string,
  req: ExchangeRequest,
  _signal?: AbortSignal,
): Promise<ExchangeResponse> {
  const res = await fetch(`${apiUrl}/v1/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: buildExchangeBody(req),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body?.error?.code && body.error.message) detail = `${body.error.code}: ${body.error.message}`;
      else if (body?.error?.code) detail = body.error.code;
    } catch {
      /* ignore */
    }
    throw new Error(`exchange failed: ${detail}`);
  }
  return (await res.json()) as ExchangeResponse;
}

export type LoginDeps = {
  startLoopback?: () => Promise<LoopbackServer>;
  exchange?: typeof exchangeCode;
  state?: () => string;
  verifier?: () => string;
  fetch?: typeof fetch;
};
export type AuthLog = (level: "info" | "warn", message: string) => void;

export type StoredAuth =
  | { type: "api"; key: string }
  | { type: "oauth"; access: string; refresh: string; expires: number }
  | null;

export function resolveStoredCredential(auth: unknown): string | undefined {
  if (typeof auth !== "object" || auth === null) return undefined;
  const a = auth as Record<string, unknown>;
  const candidate = a.type === "api" ? a.key : a.type === "oauth" ? a.access : undefined;
  return isValidCredentialShape(candidate) ? candidate : undefined;
}

export function createLunarouteAuth(opts: {
  env: NodeJS.ProcessEnv;
  onLoginSuccess?: (key: string) => void;
  log?: AuthLog;
  sessionId?: string;
  /** Effective routing URL for paste-key validation — the plugin passes its
   * user-baseURL-aware effective URL; defaults to the env-derived URL. */
  resolveRoutingUrl?: () => string;
  deps?: LoginDeps;
}): AuthHook {
  const log = opts.log ?? (() => {});
  const d = {
    startLoopback: startLoopbackServer,
    exchange: exchangeCode,
    state: generateState,
    verifier: generatePkceVerifier,
    fetch: fetch,
    ...opts.deps,
  };
  const succeed = (key: string): { type: "success"; key: string } => {
    opts.onLoginSuccess?.(key);
    return { type: "success", key };
  };
  const fail = (): { type: "failed" } => {
    log("warn", "LunaRoute login failed");
    return { type: "failed" };
  };

  return {
    provider: "lunaroute",
    loader: async (getAuth) => {
      const key = resolveStoredCredential(await getAuth());
      return key ? { apiKey: key } : {};
    },
    methods: [
      {
        type: "oauth",
        label: "Log in with browser",
        authorize: async () => {
          const verifier = d.verifier();
          const challenge = computePkceChallenge(verifier);
          const state = d.state();
          const server = await d.startLoopback();
          const url = buildDeviceAuthUrl(resolveFrontUrl(opts.env), server.port, state, challenge);
          return {
            url,
            instructions: "Complete login in your browser.",
            method: "auto" as const,
            callback: async (): Promise<{ type: "success"; key: string } | { type: "failed" }> => {
              let timer: ReturnType<typeof setTimeout> | undefined;
              const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("timed out waiting for browser authorization")),
                  LOGIN_TIMEOUT_MS,
                );
              });
              try {
                const cb = await Promise.race([server.waitForCallback(), timeout]);
                if (cb.state !== state) {
                  log("warn", "LunaRoute browser login failed: state mismatch");
                  return fail();
                }
                const result = await d.exchange(resolveApiUrl(opts.env), {
                  code: cb.code,
                  verifier,
                  label: hostname(),
                });
                return succeed(result.full_key);
              } catch (err) {
                log(
                  "warn",
                  `LunaRoute browser login error: ${err instanceof Error ? err.message : String(err)}`,
                );
                return fail();
              } finally {
                if (timer) clearTimeout(timer);
                server.close();
              }
            },
          };
        },
      },
      {
        type: "api",
        label: "Paste an API key",
        prompts: [
          {
            type: "text",
            key: "api_key",
            message: "Paste your LunaRoute API key (lr_...)",
            placeholder: "lr_...",
            validate: (value: string) =>
              isValidCredentialShape(value) ? undefined : "Key must be printable ASCII, up to 512 characters",
          },
        ],
        authorize: async (inputs?: Record<string, string>) => {
          const key = inputs?.api_key;
          if (!isValidCredentialShape(key)) return fail();
          try {
            const routingUrl = opts.resolveRoutingUrl?.() ?? resolveRoutingUrl(opts.env);
            const res = await d.fetch(`${routingUrl}/models`, {
              headers: {
                Authorization: `Bearer ${key}`,
                ...(opts.sessionId ? buildAttributionHeaders(opts.sessionId) : {}),
              },
            });
            return res.ok ? succeed(key) : fail();
          } catch {
            return fail();
          }
        },
      },
    ],
  };
}
