import { hostname } from "node:os";
import {
  buildDeviceAuthUrl,
  computePkceChallenge,
  generatePkceVerifier,
  generateState,
  isValidCredentialShape,
  LUNAROUTE_PROVIDER,
  resolveApiUrl,
  resolveFrontUrl,
} from "./lunaroute.js";
import {
  exchangeCode,
  extractPastedLogin,
  startLoopbackServer,
  type AuthLog,
  type LoginDeps,
  type LoopbackServer,
} from "./login.js";

/**
 * v2 integration registration (kata 4qqn) — the `auth` hook replacement.
 *
 * OpenCode v2 receives provider credentials through integration methods
 * (key | oauth | command | env). LunaRoute's login is a device-code exchange
 * that ends in a static `lr_` key, so:
 *   - `key`    : paste an existing key (OpenCode stores it, native form).
 *   - `browser`: loopback OAuth (`mode: "auto"`), callback resolves the key.
 *   - `remote` : paste-from-another-machine OAuth (`mode: "code"`).
 * The exchange result is carried as `Credential.OAuth` with an empty refresh
 * and a far-future expiry — the v2 credential schema requires both fields and
 * an `lr_` key is static (P1-1 spike item; the key method is the safe path).
 */

const LOGIN_TIMEOUT_MS = 3 * 60_000;

/** The remote-browser method never listens on a loopback, but DeviceAuthPage
 * only enables approval for a plausible port (1024–65535) and uses it to
 * build the callback URL the user pastes back — so pass a fixed valid one. */
const REMOTE_BROWSER_CALLBACK_PORT = 45117;

/** A static lr_ key has no expiry; keep far away from any clock/zone edge. */
const KEY_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

export type CredentialLike =
  | { type: "oauth"; methodID: string; refresh: string; access: string; expires: number }
  | { type: "key"; key: string };

export type OAuthAuthorizationLike = { url: string; instructions: string } & (
  | { mode: "auto"; callback: Promise<CredentialLike> }
  | { mode: "code"; callback: (code: string) => Promise<CredentialLike> }
);

export type MethodRegistrationLike = {
  integrationID: string;
  method:
    | { id: string; type: "oauth"; label: string }
    | { id: string; type: "command"; label: string; command: readonly string[] }
    | { type: "key"; label?: string }
    | { type: "env"; names: readonly string[] };
  authorize?: (inputs?: Record<string, string>) => Promise<OAuthAuthorizationLike>;
};

export type IntegrationEditorLike = {
  get(id: string): { id: string; name?: string } | undefined;
  update(id: string, update: (integration: { id: string; name?: string }) => void): void;
  method: { update(input: MethodRegistrationLike): void };
};

export type IntegrationCtxLike = {
  integration: {
    transform(callback: (editor: IntegrationEditorLike) => void): Promise<unknown>;
    connection: {
      active(integrationID: string): Promise<unknown>;
      resolve(connection: unknown): Promise<unknown>;
    };
  };
};

/** Structural slice for credential reads: the wire only needs the
 * connection APIs, not transform registration. */
export type ConnectionCtxLike = {
  integration: Pick<IntegrationCtxLike["integration"], "connection">;
};

export function credentialKey(credential: unknown): string | undefined {
  if (typeof credential !== "object" || credential === null) return undefined;
  const c = credential as Record<string, unknown>;
  const candidate = c.type === "key" ? c.key : c.type === "oauth" ? c.access : undefined;
  return isValidCredentialShape(candidate) ? candidate : undefined;
}

/** Read the active LunaRoute credential through the native connection APIs.
 * Replaces the v1 auth.json file reads; v2 keeps credentials in its own
 * store (the legacy auth.json entry is imported once by migration). */
export function createCredentialReader(
  ctx: ConnectionCtxLike,
  integrationID: string = LUNAROUTE_PROVIDER,
): () => Promise<string | undefined> {
  return async () => {
    try {
      const connection = await ctx.integration.connection.active(integrationID);
      if (!connection) return undefined;
      return credentialKey(await ctx.integration.connection.resolve(connection));
    } catch {
      return undefined;
    }
  };
}

export function createLunarouteIntegration(opts: {
  env: NodeJS.ProcessEnv;
  log?: AuthLog;
  deps?: LoginDeps;
}): { register(ctx: IntegrationCtxLike): Promise<void> } {
  const log = opts.log ?? (() => {});
  const d = {
    startLoopback: startLoopbackServer,
    exchange: exchangeCode,
    state: generateState,
    verifier: generatePkceVerifier,
    fetch,
    ...opts.deps,
  };

  const credential = (access: string, methodID: string): CredentialLike => ({
    type: "oauth",
    methodID,
    refresh: "",
    access,
    expires: Math.floor(Date.now() / 1000) + KEY_TTL_SECONDS,
  });

  function fail(reason: string): never {
    log("warn", `LunaRoute login failed: ${reason}`);
    throw new Error(reason);
  }

  const browserMethod = (): MethodRegistrationLike => ({
    integrationID: LUNAROUTE_PROVIDER,
    method: { id: "browser", type: "oauth", label: "Log in with browser" },
    authorize: async () => {
      const verifier = d.verifier();
      const challenge = computePkceChallenge(verifier);
      const state = d.state();
      const server: LoopbackServer = await d.startLoopback();
      const url = buildDeviceAuthUrl(resolveFrontUrl(opts.env), server.port, state, challenge);
      return {
        url,
        instructions: "Complete login in your browser.",
        mode: "auto" as const,
        callback: (async (): Promise<CredentialLike> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("timed out waiting for browser authorization")),
              LOGIN_TIMEOUT_MS,
            );
          });
          try {
            const cb = await Promise.race([server.waitForCallback(), timeout]);
            if (cb.state !== state) fail("state mismatch");
            const result = await d.exchange(resolveApiUrl(opts.env), {
              code: cb.code,
              verifier,
              label: hostname(),
            });
            return credential(result.full_key, "browser");
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes("timed out")) {
              log("info", "If your browser is on a different machine, re-run and choose 'Log in from a remote browser'.");
            }
            log("warn", `LunaRoute browser login error: ${message}`);
            throw err;
          } finally {
            if (timer) clearTimeout(timer);
            server.close();
          }
        })(),
      };
    },
  });

  const remoteMethod = (): MethodRegistrationLike => ({
    integrationID: LUNAROUTE_PROVIDER,
    method: { id: "remote", type: "oauth", label: "Log in from a remote browser" },
    authorize: async () => {
      const verifier = d.verifier();
      const challenge = computePkceChallenge(verifier);
      const state = d.state();
      const url = buildDeviceAuthUrl(resolveFrontUrl(opts.env), REMOTE_BROWSER_CALLBACK_PORT, state, challenge);
      return {
        url,
        instructions:
          "Open the URL in any browser and approve, then paste back what the approval page gives you — its curl command, the callback URL, its ?code=...&state=... part, or a bare code all work.",
        mode: "code" as const,
        callback: async (pasted: string): Promise<CredentialLike> => {
          const parsed = extractPastedLogin(pasted, state);
          if (!parsed.ok) fail(parsed.reason);
          try {
            const result = await d.exchange(resolveApiUrl(opts.env), {
              code: parsed.code,
              verifier,
              label: hostname(),
            });
            return credential(result.full_key, "remote");
          } catch (err) {
            fail(`exchange failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      };
    },
  });

  const keyMethod = (): MethodRegistrationLike => ({
    integrationID: LUNAROUTE_PROVIDER,
    method: { type: "key", label: "Paste an API key" },
  });

  return {
    register: async (ctx) => {
      await ctx.integration.transform((editor) => {
        editor.update(LUNAROUTE_PROVIDER, (integration) => {
          integration.name = "LunaRoute";
        });
        editor.method.update(browserMethod());
        editor.method.update(remoteMethod());
        editor.method.update(keyMethod());
      });
    },
  };
}
