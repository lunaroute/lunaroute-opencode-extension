import { describe, it, expect, vi } from "vitest";
import { createServer } from "node:http";
import type { AuthHook } from "@opencode-ai/plugin";
import {
  createLunarouteAuth,
  exchangeCode,
  startLoopbackServer,
  type LoopbackServer,
} from "../src/login.js";
import type { ExchangeResponse } from "../src/lunaroute.js";

// One clean local type per method shape — single-cast helpers, no `as never` chains
// (brief cleanup note: the plugin's AuthHook unions the "code"-variant callback and
// marks authorize optional; our construction always produces the shapes below).
type AuthResult = { type: "success"; key: string } | { type: "failed" };
type StartedBrowserFlow = {
  url: string;
  instructions: string;
  method: "auto";
  callback(): Promise<AuthResult>;
};
type OAuthMethod = { type: "oauth"; label: string; authorize(): Promise<StartedBrowserFlow> };
type ApiMethod = { type: "api"; label: string; authorize(inputs?: Record<string, string>): Promise<AuthResult> };

const oauthOf = (auth: AuthHook): OAuthMethod =>
  auth.methods.find((m) => m.type === "oauth") as unknown as OAuthMethod;
const apiOf = (auth: AuthHook): ApiMethod =>
  auth.methods.find((m) => m.type === "api") as unknown as ApiMethod;

const goodExchange: ExchangeResponse = { full_key: "lr_new", org_id: "org-1", user_email: "a@b.com" };

function makeAuth(overrides: Partial<Parameters<typeof createLunarouteAuth>[0]> = {}) {
  const onLoginSuccess = vi.fn();
  const auth = createLunarouteAuth({
    env: {
      LUNAROUTE_FRONT_URL: "http://front",
      LUNAROUTE_API_URL: "http://api",
      LUNAROUTE_ROUTING_URL: "http://gw/v1",
    },
    onLoginSuccess,
    deps: {
      verifier: () => "v".repeat(64),
      state: () => "st-1",
      exchange: async () => goodExchange,
      now: () => 1_000_000,
    },
    ...overrides,
  });
  return { auth, onLoginSuccess };
}

async function callLoader(auth: AuthHook, stored: unknown): Promise<Record<string, unknown>> {
  return auth.loader!(() => Promise.resolve(stored as never), undefined as never);
}

describe("loopback server", () => {
  it("serves /callback, resolves once, ignores repeat callbacks", async () => {
    const server = await startLoopbackServer();
    const res1 = await fetch(`http://127.0.0.1:${server.port}/callback?code=c&state=s`);
    expect(res1.status).toBe(200);
    await fetch(`http://127.0.0.1:${server.port}/callback?code=c2&state=s2`); // resolves a settled promise: no-op
    expect(await server.waitForCallback()).toEqual({ code: "c", state: "s" });
    server.close();
  });
  it("404s non-callback paths", async () => {
    const server = await startLoopbackServer();
    const res = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(res.status).toBe(404);
    server.close();
  });
});

describe("exchangeCode", () => {
  it("posts code+verifier+label to /v1/auth/exchange and returns the key", async () => {
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        expect(req.method).toBe("POST");
        expect(req.url).toBe("/v1/auth/exchange");
        expect(JSON.parse(body)).toEqual({ code: "c", verifier: "v", label: "h" });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(goodExchange));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const r = await exchangeCode(`http://127.0.0.1:${port}`, { code: "c", verifier: "v", label: "h" });
    expect(r.full_key).toBe("lr_new");
    srv.close();
  });
  it("throws a descriptive error on failure", async () => {
    const srv = createServer((req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { code: "INVALID_CODE", message: "bad code" } }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    await expect(
      exchangeCode(`http://127.0.0.1:${port}`, { code: "c", verifier: "v", label: "h" }),
    ).rejects.toThrow(/INVALID_CODE/);
    srv.close();
  });
});

describe("browser method (full flow)", () => {
  it("authorize returns the device-auth URL with the loopback port; callback exchanges and succeeds", async () => {
    const { auth, onLoginSuccess } = makeAuth();
    const started = await oauthOf(auth).authorize();
    expect(started.url).toMatch(/^http:\/\/front\/device-auth\/opencode\?port=\d+&state=st-1&challenge=/);
    expect(started.method).toBe("auto");
    // Simulate the browser redirect: extract the loopback port from the URL, hit /callback.
    const port = Number(new URL(started.url).searchParams.get("port"));
    await fetch(`http://127.0.0.1:${port}/callback?code=raw-code&state=st-1`);
    const result = await started.callback();
    expect(result).toEqual({ type: "success", key: "lr_new" });
    expect(onLoginSuccess).toHaveBeenCalledWith("lr_new");
  });

  it("state mismatch fails the callback", async () => {
    const { auth, onLoginSuccess } = makeAuth();
    const started = await oauthOf(auth).authorize();
    const port = Number(new URL(started.url).searchParams.get("port"));
    await fetch(`http://127.0.0.1:${port}/callback?code=raw-code&state=WRONG`);
    expect(await started.callback()).toEqual({ type: "failed" });
    expect(onLoginSuccess).not.toHaveBeenCalled();
  });

  it("times out after 3 minutes, fails (never rejects), and releases the listener", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn();
      const fakeServer: LoopbackServer = {
        port: 39999,
        waitForCallback: () => new Promise(() => {}), // the browser never arrives
        close,
      };
      const { auth, onLoginSuccess } = makeAuth({
        deps: { startLoopback: async () => fakeServer },
      });
      const started = await oauthOf(auth).authorize();
      const promise = started.callback();
      await vi.advanceTimersByTimeAsync(3 * 60_000 + 10);
      // The AuthOAuthResult contract resolves with "failed" — OpenCode never sees a rejection.
      await expect(promise).resolves.toEqual({ type: "failed" });
      expect(close).toHaveBeenCalled();
      expect(onLoginSuccess).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("paste method", () => {
  it("validates shape, fetches the gateway, and returns the key on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    const { auth, onLoginSuccess } = makeAuth({
      deps: { fetch: fetchMock as unknown as typeof fetch },
    });
    const res = await apiOf(auth).authorize({ api_key: "lr_good" });
    expect(res).toEqual({ type: "success", key: "lr_good" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://gw/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer lr_good" } }),
    );
    expect(onLoginSuccess).toHaveBeenCalledWith("lr_good");
  });
  it("fails on bad shape without touching the network", async () => {
    const fetchMock = vi.fn();
    const { auth } = makeAuth({ deps: { fetch: fetchMock as unknown as typeof fetch } });
    const res = await apiOf(auth).authorize({ api_key: "bad\nkey" });
    expect(res).toEqual({ type: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("fails when the gateway rejects the key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const { auth } = makeAuth({ deps: { fetch: fetchMock as unknown as typeof fetch } });
    expect(await apiOf(auth).authorize({ api_key: "lr_stale" })).toEqual({ type: "failed" });
  });
});

describe("loader", () => {
  it("returns apiKey for stored credentials (api and oauth shapes)", async () => {
    const { auth } = makeAuth();
    expect(await callLoader(auth, { type: "api", key: "lr_x" })).toEqual({ apiKey: "lr_x" });
    expect(
      await callLoader(auth, { type: "oauth", access: "lr_y", refresh: "", expires: 1 }),
    ).toEqual({ apiKey: "lr_y" });
  });
  it("returns {} silently when not logged in or malformed", async () => {
    const { auth } = makeAuth();
    expect(await callLoader(auth, null)).toEqual({});
    expect(await callLoader(auth, { type: "api", key: "bad\nkey" })).toEqual({});
  });
});
