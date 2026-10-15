import { createServer, type Server } from "node:http";
import { buildExchangeBody, parseCallbackQuery, type ExchangeRequest, type ExchangeResponse } from "./lunaroute.js";



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
    // kata y992 (saas d16f / roborev 1546): let the approval page verify
    // delivery via a cors fetch + res.ok — only readable cross-origin with
    // this header. Static "close this tab" body, no secrets; the GET was
    // never CORS-gated, so `*` grants no new reach.
    res.setHeader("Access-Control-Allow-Origin", "*");
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

/**
 * Remote-browser paste ladder (kata dw0g), pure. The approval page's only
 * copy artifact today is a curl command wrapping the callback URL; a paste
 * may also be the bare URL, a code=...&state=... query, or a bare code.
 * State is compared only when the paste carries one — the gateway's
 * single-use + short-TTL code validation is the binding for bare codes.
 */
export function extractPastedLogin(
  pasted: string,
  expectedState: string,
): { ok: true; code: string } | { ok: false; reason: string } {
  const trimmed = pasted.trim();
  if (!trimmed) return { ok: false, reason: "nothing pasted" };
  const urlMatch = trimmed.match(/https?:\/\/[^\s'"]+/i);
  let normalized: string;
  if (urlMatch) {
    normalized = urlMatch[0];
  } else if (/(?:^|[&?])(?:code|state)=/i.test(trimmed)) {
    // Accept a bare "code=..&state=.." query string (optional leading ?).
    normalized = `http://127.0.0.1/callback?${trimmed.replace(/^\?/, "")}`;
  } else if (/^[A-Za-z0-9._~-]{1,256}={0,2}$/.test(trimmed)) {
    // A bare authorization code: a single URL-safe token, Base64 trailing
    // padding allowed (roborev job 1850: `abc=` must not be mistaken for a
    // query string).
    normalized = `http://127.0.0.1/callback?code=${encodeURIComponent(trimmed)}`;
  } else {
    return { ok: false, reason: "no code found in paste" };
  }
  const cb = parseCallbackQuery(normalized);
  if (!cb.code) return { ok: false, reason: "no code found in paste" };
  if (new URL(normalized).searchParams.has("state") && cb.state !== expectedState) {
    return { ok: false, reason: "state mismatch" };
  }
  return { ok: true, code: cb.code };
}
