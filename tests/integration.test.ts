import { describe, it, expect, vi } from "vitest";
import {
  createLunarouteIntegration,
  createCredentialReader,
  credentialKey,
  type IntegrationCtxLike,
  type MethodRegistrationLike,
  type OAuthAuthorizationLike,
} from "../src/integration.js";
import type { LoginDeps } from "../src/login.js";

type Recorded = { methods: MethodRegistrationLike[]; refUpdates: { id: string; name?: string }[] };

function makeCtx(): { ctx: IntegrationCtxLike; recorded: Recorded } {
  const recorded: Recorded = { methods: [], refUpdates: [] };
  const ctx: IntegrationCtxLike = {
    integration: {
      transform: async (cb) => {
        cb({
          get: () => undefined,
          update: (id, update) => {
            const ref: { id: string; name?: string } = { id };
            update(ref);
            recorded.refUpdates.push(ref);
          },
          method: { update: (input) => recorded.methods.push(input) },
        });
        return {};
      },
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
    },
  };
  return { ctx, recorded };
}

const exchangeOK = async () => ({ full_key: "lr_full", org_id: "o", user_email: "u" });

function deps(over: Partial<LoginDeps> = {}): LoginDeps {
  return {
    startLoopback: async () => ({
      port: 12345,
      waitForCallback: async () => ({ code: "code-1", state: "state-1" }),
      close: vi.fn(),
    }),
    exchange: exchangeOK,
    state: () => "state-1",
    verifier: () => "verifier-1",
    ...over,
  };
}

const opts = (over: Partial<Parameters<typeof createLunarouteIntegration>[0]> = {}) => ({
  env: {} as NodeJS.ProcessEnv,
  log: vi.fn(),
  deps: deps(),
  ...over,
});

describe("createLunarouteIntegration", () => {
  it("registers the integration name and three auth methods", async () => {
    const { ctx, recorded } = makeCtx();
    await createLunarouteIntegration(opts()).register(ctx);

    expect(recorded.refUpdates).toEqual([{ id: "lunaroute", name: "LunaRoute" }]);
    const methods = recorded.methods.map((m) => m.method);
    expect(methods.map((m) => m.type)).toEqual(["oauth", "oauth", "key"]);
    expect(methods[0]).toMatchObject({ id: "browser", label: "Log in with browser" });
    expect(methods[1]).toMatchObject({ id: "remote", label: "Log in from a remote browser" });
    expect(methods[2]).toMatchObject({ type: "key", label: "Paste an API key" });
    expect(recorded.methods.every((m) => m.integrationID === "lunaroute")).toBe(true);
  });

  it("browser flow: authorize returns url + instructions, callback yields an OAuth credential", async () => {
    const { ctx, recorded } = makeCtx();
    await createLunarouteIntegration(
      opts({ env: { LUNAROUTE_FRONT_URL: "https://app.example" } as NodeJS.ProcessEnv }),
    ).register(ctx);
    const browser = recorded.methods[0] as MethodRegistrationLike & { authorize: () => Promise<OAuthAuthorizationLike> };

    const auth = await browser.authorize();
    expect(auth.mode).toBe("auto");
    expect(auth.url.startsWith("https://app.example/device-auth/opencode?")).toBe(true);
    expect(auth.url).toContain("port=12345");
    expect(auth.url).toContain("state=state-1");
    expect(auth.instructions).toContain("browser");

    const cred = await (auth as { callback: Promise<Record<string, unknown>> }).callback;
    expect(cred).toMatchObject({ type: "oauth", methodID: "browser", refresh: "", access: "lr_full" });
    expect(cred.expires as number).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("browser flow rejects on state mismatch", async () => {
    const d = deps({
      startLoopback: async () => ({
        port: 12345,
        waitForCallback: async () => ({ code: "code-1", state: "other" }),
        close: vi.fn(),
      }),
    });
    const { ctx, recorded } = makeCtx();
    await createLunarouteIntegration(opts({ deps: d })).register(ctx);
    const auth = await (recorded.methods[0] as MethodRegistrationLike & {
      authorize: () => Promise<OAuthAuthorizationLike>;
    }).authorize();
    await expect((auth as { callback: Promise<unknown> }).callback).rejects.toThrow(/state mismatch/);
  });

  it("remote flow: accepts a curl command, a callback URL, a bare code", async () => {
    const exchange = vi.fn(exchangeOK);
    const { ctx, recorded } = makeCtx();
    await createLunarouteIntegration(opts({ deps: deps({ exchange }) })).register(ctx);
    const remote = recorded.methods[1] as MethodRegistrationLike & {
      authorize: () => Promise<OAuthAuthorizationLike>;
    };
    const auth = await remote.authorize();
    expect(auth.mode).toBe("code");
    const callback = (auth as { callback: (code: string) => Promise<Record<string, unknown>> }).callback;

    const fromCurl = await callback("curl 'http://127.0.0.1:45117/callback?code=curl-code&state=state-1'");
    expect(fromCurl.access).toBe("lr_full");
    expect(exchange).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ code: "curl-code" }));

    const fromBare = await callback("bare-code");
    expect(exchange).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ code: "bare-code" }));
  });

  it("remote flow rejects empty paste, junk, and state mismatch", async () => {
    const { ctx, recorded } = makeCtx();
    await createLunarouteIntegration(opts()).register(ctx);
    const auth = await (recorded.methods[1] as MethodRegistrationLike & {
      authorize: () => Promise<OAuthAuthorizationLike>;
    }).authorize();
    const callback = (auth as { callback: (code: string) => Promise<unknown> }).callback;

    await expect(callback("")).rejects.toThrow(/nothing pasted/);
    await expect(callback("not a code !!")).rejects.toThrow(/no code found/);
    await expect(callback("http://127.0.0.1:45117/callback?code=x&state=wrong")).rejects.toThrow(/state mismatch/);
  });
});

describe("credentialKey / createCredentialReader", () => {
  it("reads a key credential and an oauth access token", async () => {
    expect(credentialKey({ type: "key", key: "lr_k" })).toBe("lr_k");
    expect(credentialKey({ type: "oauth", access: "lr_a", refresh: "r", expires: 1 })).toBe("lr_a");
    expect(credentialKey({ type: "external" })).toBeUndefined();
    expect(credentialKey(null)).toBeUndefined();
    expect(credentialKey({ type: "key", key: "bad\nkey" })).toBeUndefined();
  });

  it("resolves the active connection credential, undefined when absent", async () => {
    const ctx = {
      integration: {
        connection: {
          active: async (id: string) => (id === "lunaroute" ? { type: "credential", id: "c1" } : undefined),
          resolve: async () => ({ type: "key", key: "lr_live" }),
        },
      },
    };
    const read = createCredentialReader(ctx);
    expect(await read()).toBe("lr_live");

    const empty = createCredentialReader({
      integration: { connection: { active: async () => undefined, resolve: async () => ({ type: "key", key: "x" }) } },
    });
    expect(await empty()).toBeUndefined();
  });
});
