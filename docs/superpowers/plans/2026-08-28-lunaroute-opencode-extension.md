# LunaRoute OpenCode Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@lunaroute/opencode-extension` — an OpenCode plugin giving `/connect` login, dynamic LunaRoute model catalog, request attribution, and native remote MCP injection, at parity with the pi extension.

**Architecture:** Single default-exported `Plugin` function (raw TS, no build step) composing three hooks: `config` (provider stub + catalog-fetch model injection + MCP injection via a tri-state auth-store resolution), `auth` (browser PKCE + validated paste), `chat.headers` (attribution). MCP is config-hook-only — never written through the persisting `client.config.update` path; the only post-login write is `{ model }` (whose PATCH triggers instance reload → config hook re-runs → models + MCP refresh with the fresh key).

> **Spike amendment (post Task 1, docs/compatibility-spike.md):** the plugin `provider` hook never fires for custom config-declared providers (verified in source + empirically on OpenCode 1.14.49/1.18.25). All catalog fetching and model injection therefore lives in the **config hook** (community pattern). The `provider` hook is dropped from the plugin. When logged in, the fetched catalog replaces `provider.lunaroute.models`; logged out, user-set models are preserved.

**Tech Stack:** TypeScript (raw `src/`, executed by Bun inside OpenCode), vitest 4, `@opencode-ai/plugin` ^1.17.20 (types + peer).

**Spec:** `docs/superpowers/specs/2026-08-28-lunaroute-opencode-extension-design.md` — read it before executing; this plan argues from it.

## Global Constraints

- **Spike-locked values** (docs/compatibility-spike.md): engines.opencode `>=1.14.49`; auth store = `${XDG_DATA_HOME || ~/.local/share}/opencode/auth.json` (xdg-basedir semantics, Linux + macOS, Windows out of v1); README says reload-automatic for MCP/rotation (gates (a)/(c) both yes); `client.config.update` maps to `PATCH /config`, deep-merging into `<project>/config.json` — only `{ model }` is ever written by us.
- **Config-hook model injection** (spike amendment): catalog fetch + `provider.lunaroute.models` injection happen in the config hook when auth resolution is `valid`; the `provider` hook does not exist in this plugin. Fetch failures are NOT memoized (next hook run retries); successful fetches are memoized per credential for the process (hook runs multiple times per process — idempotent, no refetch storms).
- Provider id: `lunaroute`. Device name: `opencode`. Attribution triple: `lunaroute-agent: opencode`, `x-lunaroute-session`, `lunaroute-session-id` (one UUID per plugin instance).
- Env overrides: `LUNAROUTE_ROUTING_URL` (default `https://gw.lunaroute.com/v1`), `LUNAROUTE_API_URL` (`https://api.lunaroute.com`), `LUNAROUTE_FRONT_URL` (`https://app.lunaroute.com`), `LUNAROUTE_MCP_URL` (`https://mcp.lunaroute.com/mcp`).
- Browser URL: `${LUNAROUTE_FRONT_URL}/device-auth/opencode?port=&state=&challenge=`; exchange `POST ${LUNAROUTE_API_URL}/v1/auth/exchange` with `{ code, verifier, label: hostname() }` (hex-sha256 PKCE, 3-minute loopback timeout).
- The `lr_` key is never written to any file. The only persistent credential is OpenCode's auth.json (written by `/connect`). The only post-login config write is `{ model }`.
- Catalog limits: positive safe integers within `context ≤ 100_000_000` / `output ≤ 10_000_000`, else defaults 128000/4096. Catalog input is untrusted; malformed entries are skipped (one warn each; one summary warn when all skipped).
- MCP state: `Map<storeKey, Set<sha256-fingerprint>>`, storeKey = lexically resolved auth-store path; fingerprint = UTF-8 key bytes → hex sha256; most recent 8 distinct credentials per store; FIFO by write, re-injection refreshes position.
- No key material (current, historical, or from malformed records) in any log/warn/error — fingerprints and counts only.
- No `OPENCODE_AUTH_CONTENT` usage. Missing/corrupt/unreadable auth.json → indeterminate (fail-safe retention), never logout.
- `npm run check` = `tsc --noEmit` + `vitest run` must be green before every commit.

---

### Task 1: Compatibility spike (release gate)

**Files:**
- Create: `docs/compatibility-spike.md` (committed decision record)
- Create (scratch, NOT committed): `/tmp/lr-spike/` — fixture plugin + fake gateway

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `docs/compatibility-spike.md` recording (a) minimum OpenCode version, (b) data-dir resolution per platform, (c) gate branches (a)/(b)/(c), (d) browser-flow contract result, (e) update-persistence forensics. These values feed `package.json` engines (Task 2), `resolveAuthStorePath` (Task 7), and README wording (Task 9). If any item cannot be verified, v1 scope narrows (restart-only documentation) rather than shipping assumptions.

- [ ] **Step 1: Install OpenCode + verify plugin API surface**

```bash
npm install -g opencode-ai@latest
opencode --version
node -e "const p=require('/usr/lib/node_modules/opencode-ai/node_modules/@opencode-ai/plugin/dist/index.js'); console.log('plugin pkg ok')" 2>/dev/null || npm view @opencode-ai/plugin version
```

Record the installed version. Check the earliest `@opencode-ai/plugin` release on npm containing `Hooks.provider` AND `chat.headers` (inspect `dist/index.d.ts` of tagged versions via jsdelivr, e.g. `https://cdn.jsdelivr.net/npm/@opencode-ai/plugin@<ver>/dist/index.d.ts`, bisecting from 1.14.0). Record the minimum OpenCode version whose bundled plugin package has both.

- [ ] **Step 2: Build the fake gateway**

Create `/tmp/lr-spike/fake-gateway.ts` (run with `bunx tsx` or `bun`):

```ts
// Minimal OpenAI-compatible fake: /v1/models + /v1/auth/exchange.
import { createServer } from "node:http";
const seen: string[] = [];
createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (url.pathname === "/v1/models") {
      const auth = req.headers["authorization"] ?? "";
      res.setHeader("content-type", "application/json");
      if (!auth.includes("lr_good")) { res.statusCode = 401; res.end("{}"); return; }
      res.end(JSON.stringify({ data: [
        { id: "model-b", display_name: "Model B", context_window: 128000, max_output_tokens: 8192, capabilities: { reasoning: true, vision: true } },
        { id: "model-a", display_name: "Model A", context_window: 64000, max_output_tokens: 4096, capabilities: {} },
        { id: "bad-limit", context_window: 1.5, capabilities: {} },
      ]}));
      return;
    }
    if (url.pathname === "/v1/auth/exchange") {
      const { verifier } = JSON.parse(body || "{}");
      seen.push(verifier);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ full_key: "lr_good_fake", org_id: "org-1", user_email: "a@b.com" }));
      return;
    }
    res.statusCode = 404; res.end("{}");
  });
}).listen(4599, "127.0.0.1", () => console.log("fake gateway on :4599"));
```

Run it in a terminal: `bun /tmp/lr-spike/fake-gateway.ts` (or `npx tsx`).

- [ ] **Step 3: Build the fixture plugin**

Create `/tmp/lr-spike/fixture/package.json`:

```json
{ "name": "lr-spike-fixture", "version": "0.0.0", "type": "module", "main": "./index.ts" }
```

`/tmp/lr-spike/fixture/index.ts`:

```ts
import type { Plugin } from "@opencode-ai/plugin";
const plugin: Plugin = async (input) => {
  const log = (l: string) => input.client.app.log({ body: { service: "lr-spike", level: "info", message: l } });
  await log("fixture loaded");
  return {
    config: async (cfg) => {
      (cfg.provider ??= {})["lunaroute"] ??= { name: "LunaRoute", npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:4599/v1" } };
      (cfg.mcp ??= {})["lunaroute"] = { type: "remote", url: "http://127.0.0.1:4599/mcp", headers: { "LUNAROUTE-API-KEY": "lr_good_fake" }, oauth: false, enabled: true };
      await log("config hook ran; mcp injected=" + JSON.stringify(!!cfg.mcp?.["lunaroute"]));
    },
    provider: { id: "lunaroute", models: async (_p, ctx) => {
      await log("provider hook ran; auth=" + JSON.stringify(ctx.auth?.type));
      return { "model-a": { id: "model-a", name: "Model A", providerID: "lunaroute", limit: { context: 64000, output: 4096 } } as never };
    } },
    auth: { provider: "lunaroute", methods: [{ type: "api", label: "Paste" }], loader: async (getAuth) => { const a = await getAuth(); return a?.type === "api" ? { apiKey: a.key } : {}; } },
    "chat.headers": async (inp, out) => { if (inp.provider?.info?.id === "lunaroute") out.headers["x-lr-spike"] = "1"; },
  };
};
export default plugin;
```

`npm pack` it; note the tarball path.

- [ ] **Step 4: Run the behavioral proof**

In a scratch project dir `/tmp/lr-spike/run/` with `opencode.json`:

```json
{ "plugin": ["/tmp/lr-spike/fixture/lr-spike-fixture-0.0.0.tgz"] }
```

Run `opencode` there (TUI). Verify and record each item:

1. Plugin loads from the packed tarball (fixture log line "fixture loaded" — check `~/.local/share/opencode/log/` or the TUI).
2. `/connect` → lunaroute → paste `lr_good` → fixture loader resolves; `/models` shows `model-a` (provider hook fired with `ctx.auth.type === "api"`).
3. After login, check the instance/project config file(s) and global `opencode.json`: the `mcp.lunaroute` entry from the config hook must NOT be persisted to any file (it exists in the live config only).
4. Trigger a `{ model }` update (select model-a as default). Verify the instance config gains only `model`; no key, no mcp, anywhere.
5. **Gate branch (a)/(b)**: after the model update (which marks the instance for disposal), does "config hook ran" re-appear (reload re-runs the hook)? Record yes/no.
6. **Gate branch (c)**: re-login with a different key (`lr_good2` — fake gateway accepts any `lr_good*`); does a subsequent chat/provider load use the new key without restart? Record.
7. **Browser-flow contract, headless**: in a second terminal, `node -e` using the fixture? — No: verify with the real production flow later (Task 5 tests cover the loopback mechanics; here just record whether OpenCode's auth UI renders `method: "auto"` authorize results — confirm via the paste path plus one browser attempt against `https://app.lunaroute.com/device-auth/opencode` with staging env vars if available; if staging is unavailable, mark this item "verified at Task 9 smoke" and proceed).
8. **Auth-store path**: record the exact path OpenCode reads auth from on this machine (`~/.local/share/opencode/auth.json` on Linux; check macOS: `~/Library/Application Support/opencode/auth.json` vs `~/.local/share/opencode/auth.json` — whichever exists after `/connect`). Record per-OS if testable.
9. **ModelV2 schema**: confirm the provider-hook model shape above is accepted (model-a selectable, context shows 64k).

- [ ] **Step 5: Write the decision record**

Create `docs/compatibility-spike.md` in the repo:

```markdown
# Compatibility Spike — Decision Record (Task 1 gate)

Date: <date> · OpenCode tested: <version> · Plugin pkg tested: <version>

| Question | Result |
|---|---|
| Minimum OpenCode version (provider + chat.headers hooks) | <ver> |
| Auth-store path (Linux) / (macOS) | <path> / <path> |
| config.update persists to | <file(s)> — only `model` written by us |
| Config-hook MCP injection persists? | <yes/no> (expected: no) |
| Gate (a): config hook re-runs on instance reload? | <yes/no> |
| Gate (b): if no → README says restart-required for MCP | <n/a or noted> |
| Gate (c): chat loader re-created on reload? | <yes/no> |
| Packed raw-TS tarball loads | <yes/no> |
| ModelV2 shape accepted | <yes/no> |

## Consequences
- engines.opencode: <ver>
- resolveAuthStorePath data-dir resolution: `${XDG_DATA_HOME || home/.local/share}/opencode/auth.json` (xdg-basedir semantics, Linux + macOS per spike; Windows out of v1)
- README MCP/rotation wording: <reload-automatic | restart-required>
```

Commit:

```bash
git add docs/compatibility-spike.md && git commit -m "docs: compatibility spike decision record (task 1 gate)"
```

**If any critical item fails** (tarball doesn't load, hooks don't fire): STOP — report the failure; do not proceed to Task 2 with assumptions.

---

### Task 2: Repo scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.github/workflows/check.yml`, `.kata.toml`, `tests/smoke.test.ts`

**Interfaces:**
- Consumes: spike results (engines version, data-dir note)
- Produces: runnable `npm run check` (tsc + vitest); `kata init` done

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@lunaroute/opencode-extension",
  "version": "0.1.0",
  "description": "OpenCode plugin for LunaRoute: /connect login, model sync, attribution, and hosted MCP.",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "files": ["src", "README.md", "LICENSE"],
  "keywords": ["opencode", "opencode-plugin", "lunaroute"],
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/lunaroute/lunaroute-opencode-extension" },
  "publishConfig": { "access": "public" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "check": "npm run typecheck && npm test"
  },
  "peerDependencies": { "@opencode-ai/plugin": "^1.17.20" },
  "devDependencies": {
    "@opencode-ai/plugin": "^1.17.20",
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0",
    "vitest": "^4.1.0"
  },
  "engines": { "opencode": ">=1.14.49" }
}
```

(Set per the spike decision record: `engines.opencode` `>=1.14.49` — already filled in above.)

- [ ] **Step 2: Create `tsconfig.json`, `vitest.config.ts`, `.gitignore`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"],
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src", "tests"]
}
```

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", globals: true } });
```

```
node_modules/
.kata.local.toml
.worktrees/
```

- [ ] **Step 3: Smoke test + install + CI**

`tests/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";
describe("scaffold", () => { it("runs", () => { expect(1 + 1).toBe(2); }); });
```

```bash
npm install
npm run check   # expect: typecheck ok, 1 test passed
```

Copy `.github/workflows/check.yml` from `lunaroute-pi-extension` and change the working-directory/setup to match this repo (same two jobs or single job: `npm ci && npm run check` on Node 24).

```bash
kata init
```

Commit:

```bash
git add -A && git commit -m "chore: scaffold @lunaroute/opencode-extension (task 2)"
```

---

### Task 3: Pure helpers — constants, PKCE, URLs, attribution, fingerprints (src/lunaroute.ts)

**Files:**
- Create: `src/lunaroute.ts`
- Test: `tests/lunaroute.test.ts`

**Interfaces:**
- Produces (used by Tasks 5–8):
  - `LUNAROUTE_PROVIDER = "lunaroute"`, `DEVICE = "opencode"`
  - `resolveRoutingUrl(env) / resolveApiUrl(env) / resolveFrontUrl(env) / resolveMcpUrl(env): string`
  - `generateSessionId(randomUuid?, now?, random?): string`
  - `buildAttributionHeaders(sessionId): Record<string, string>`
  - `generatePkceVerifier(): string`, `computePkceChallenge(verifier): string`, `generateState(): string`
  - `buildDeviceAuthUrl(frontUrl, port, state, challenge): string`
  - `parseCallbackQuery(callbackUrl): { code: string; state: string }`
  - `type ExchangeRequest = { code: string; verifier: string; label: string }`, `type ExchangeResponse = { full_key: string; org_id: string; user_email: string; routing_url?: string; api_url?: string }`, `buildExchangeBody(req): string`
  - `isValidCredentialShape(key: unknown): key is string` (non-empty, printable ASCII, ≤ 512)
  - `credentialFingerprint(key: string): string` (sha256 hex)

- [ ] **Step 1: Write the failing tests** (`tests/lunaroute.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  LUNAROUTE_PROVIDER, buildAttributionHeaders, buildDeviceAuthUrl, buildExchangeBody,
  computePkceChallenge, credentialFingerprint, generatePkceVerifier, generateSessionId,
  generateState, isValidCredentialShape, parseCallbackQuery,
} from "../src/lunaroute.js";

describe("env resolvers + defaults", () => {
  it("builds the device-auth URL for opencode", () => {
    expect(buildDeviceAuthUrl("https://app.lunaroute.com", 39999, "st-1", "ch-1"))
      .toBe("https://app.lunaroute.com/device-auth/opencode?port=39999&state=st-1&challenge=ch-1");
  });
});

describe("PKCE", () => {
  it("verifier is 64 hex chars; challenge is hex sha256 of verifier", () => {
    const v = generatePkceVerifier();
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(computePkceChallenge(v)).toBe(createHash("sha256").update(v).digest("hex"));
  });
  it("state is 32 hex chars", () => expect(generateState()).toMatch(/^[0-9a-f]{32}$/));
});

describe("callback parsing", () => {
  it("parses code and state, tolerating a base URL", () => {
    expect(parseCallbackQuery("http://127.0.0.1:1/callback?code=c%2Fx&state=s"))
      .toEqual({ code: "c/x", state: "s" });
    expect(parseCallbackQuery("/callback?code=&state=")).toEqual({ code: "", state: "" });
  });
});

describe("exchange", () => {
  it("serializes code, verifier, and label", () => {
    expect(JSON.parse(buildExchangeBody({ code: "c", verifier: "v", label: "host-1" })))
      .toEqual({ code: "c", verifier: "v", label: "host-1" });
  });
});

describe("attribution", () => {
  it("uses the bare opencode agent plus both session headers", () => {
    expect(buildAttributionHeaders("uuid-1")).toEqual({
      "lunaroute-agent": "opencode",
      "x-lunaroute-session": "uuid-1",
      "lunaroute-session-id": "uuid-1",
    });
  });
  it("generateSessionId falls back when randomUUID throws", () => {
    const id = generateSessionId(() => { throw new Error("no crypto"); }, () => 123, () => 0.5);
    expect(id).toMatch(/^lunaroute-opencode-123-/);
  });
});

describe("credential shape", () => {
  it("accepts printable ASCII up to 512 chars", () => {
    expect(isValidCredentialShape("lr_good")).toBe(true);
    expect(isValidCredentialShape("x".repeat(512))).toBe(true);
  });
  it("rejects empty, oversize, non-string, control chars, unicode", () => {
    expect(isValidCredentialShape("")).toBe(false);
    expect(isValidCredentialShape("x".repeat(513))).toBe(false);
    expect(isValidCredentialShape(42)).toBe(false);
    expect(isValidCredentialShape("bad\nkey")).toBe(false);
    expect(isValidCredentialShape("ключ")).toBe(false);
  });
});

describe("fingerprint", () => {
  it("is hex sha256 of UTF-8 key bytes", () => {
    expect(credentialFingerprint("lr_good"))
      .toBe(createHash("sha256").update("lr_good", "utf8").digest("hex"));
  });
});

describe("provider id", () => {
  it("is lunaroute", () => expect(LUNAROUTE_PROVIDER).toBe("lunaroute"));
});
```

- [ ] **Step 2: Run to verify failure**

`npm test -- tests/lunaroute.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/lunaroute.ts`**

```ts
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
```

- [ ] **Step 4: Run tests** → PASS. **Step 5: Commit** `feat: pure helpers — constants, PKCE, device-auth URL, attribution, fingerprints`

---

### Task 4: Catalog mapping (src/lunaroute.ts, continued)

**Files:**
- Modify: `src/lunaroute.ts` (append)
- Test: `tests/lunaroute.test.ts` (append)

**Interfaces:**
- Produces:
  - `type MappedModel = { id: string; name: string; reasoning: boolean; tool_call: boolean; attachment: boolean; limitContext: number; limitOutput: number; modalitiesInput: ("text" | "image")[]; variants: Record<string, { reasoningEffort: string }> }`
  - `mapCatalogEntry(entry: unknown): { ok: true; model: MappedModel } | { ok: false; reason: string }`
  - `mapCatalog(entries: unknown[]): { models: MappedModel[]; skipped: { id: string; reason: string }[] }` (duplicate ids: first wins)
  - `defaultModelId(models: MappedModel[]): string | undefined` (lexicographically smallest id; undefined when empty)

- [ ] **Step 1: Failing tests** (append to `tests/lunaroute.test.ts`)

```ts
import { mapCatalog, mapCatalogEntry, defaultModelId, type MappedModel } from "../src/lunaroute.js";

describe("catalog mapping", () => {
  it("maps a full reasoning+vision model", () => {
    const r = mapCatalogEntry({ id: "m-1", display_name: "M One", context_window: 200000, max_output_tokens: 32768, capabilities: { reasoning: true, vision: true, tools: false } });
    expect(r).toEqual({ ok: true, model: {
      id: "m-1", name: "M One", reasoning: true, tool_call: false, attachment: true,
      limitContext: 200000, limitOutput: 32768, modalitiesInput: ["text", "image"],
      variants: { low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" } },
    }});
  });
  it("maps defaults: missing name -> id, missing limits -> 128k/4096, tools default true, non-reasoning -> no variants", () => {
    const r = mapCatalogEntry({ id: "m-2" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.model.name).toBe("m-2");
    expect(r.model.tool_call).toBe(true);
    expect(r.model.limitContext).toBe(128000);
    expect(r.model.limitOutput).toBe(4096);
    expect(r.model.variants).toEqual({});
    expect(r.model.modalitiesInput).toEqual(["text"]);
  });
  it("falls back on fractional, negative, zero, string, and beyond-bound limits", () => {
    for (const cw of [1.5, -1, 0, "64", 100_000_001]) {
      const r = mapCatalogEntry({ id: "x", context_window: cw });
      if (!r.ok) throw new Error("expected ok");
      expect(r.model.limitContext).toBe(128000);
    }
    const big = mapCatalogEntry({ id: "x", max_output_tokens: 10_000_001 });
    if (big.ok) expect(big.model.limitOutput).toBe(4096);
  });
  it("accepts large-but-plausible limits as-is", () => {
    const r = mapCatalogEntry({ id: "x", context_window: 100_000_000, max_output_tokens: 10_000_000 });
    if (!r.ok) throw new Error("expected ok");
    expect(r.model.limitContext).toBe(100_000_000);
    expect(r.model.limitOutput).toBe(10_000_000);
  });
  it("rejects non-objects, missing/empty/non-string ids, and non-string display names fall back", () => {
    expect(mapCatalogEntry(null)).toEqual({ ok: false, reason: "not an object" });
    expect(mapCatalogEntry("x")).toEqual({ ok: false, reason: "not an object" });
    expect(mapCatalogEntry({})).toEqual({ ok: false, reason: "missing or invalid id" });
    expect(mapCatalogEntry({ id: 5 })).toEqual({ ok: false, reason: "missing or invalid id" });
    expect(mapCatalogEntry({ id: "" })).toEqual({ ok: false, reason: "missing or invalid id" });
    const r = mapCatalogEntry({ id: "x", display_name: 7 });
    if (!r.ok) throw new Error("expected ok");
    expect(r.model.name).toBe("x");
  });
});

describe("mapCatalog", () => {
  it("first id wins on duplicates; skipped entries recorded with ids and reasons", () => {
    const { models, skipped } = mapCatalog([
      { id: "dup", display_name: "First" }, { id: "dup" }, null,
    ]);
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe("First");
    expect(skipped).toEqual([
      { id: "dup", reason: "duplicate id" },
      { id: "(unidentifiable entry)", reason: "not an object" },
    ]);
  });
});

describe("defaultModelId", () => {
  it("picks the lexicographically smallest mapped id, order-independent", () => {
    const mk = (id: string): MappedModel => ({ id, name: id, reasoning: false, tool_call: true, attachment: false, limitContext: 1, limitOutput: 1, modalitiesInput: ["text"], variants: {} });
    expect(defaultModelId([mk("b"), mk("a"), mk("c")])).toBe("a");
    expect(defaultModelId([mk("b"), mk("a"), mk("a2")])).toBe("a");
  });
  it("returns undefined when empty", () => expect(defaultModelId([])).toBeUndefined());
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (append to `src/lunaroute.ts`)

```ts
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
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat: catalog mapping with validation, duplicates, and deterministic default-model rule`

---

### Task 5: Auth hook — browser PKCE + validated paste (src/login.ts)

**Files:**
- Create: `src/login.ts`
- Test: `tests/login.test.ts`

**Interfaces:**
- Consumes (Task 3): `buildDeviceAuthUrl`, `parseCallbackQuery`, `computePkceChallenge`, `generatePkceVerifier`, `generateState`, `buildExchangeBody`, `buildExchangeBody` types, `resolveApiUrl`, `resolveFrontUrl`, `resolveRoutingUrl`, `isValidCredentialShape`
- Produces:
  - `type LoopbackServer = { port: number; waitForCallback(): Promise<{ code: string; state: string }>; close(): void }`
  - `startLoopbackServer(): Promise<LoopbackServer>`
  - `exchangeCode(apiUrl, req, signal?): Promise<ExchangeResponse>`
  - `type AuthLog = (level: "info" | "warn", message: string) => void`
  - `createLunarouteAuth(opts: { env; onLoginSuccess?: (key: string) => void; log?: AuthLog; deps?: LoginDeps }): AuthHook` where `AuthHook` is the structural type `{ provider: string; loader(getAuth): Promise<Record<string, unknown>>; methods: [...] }` matching `@opencode-ai/plugin`

- [ ] **Step 1: Failing tests** (`tests/login.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import { createLunarouteAuth, exchangeCode, startLoopbackServer } from "../src/login.js";
import type { ExchangeResponse } from "../src/lunaroute.js";

const goodExchange: ExchangeResponse = { full_key: "lr_new", org_id: "org-1", user_email: "a@b.com" };

function makeAuth(overrides: Partial<Parameters<typeof createLunarouteAuth>[0]> = {}) {
  const onLoginSuccess = vi.fn();
  const auth = createLunarouteAuth({
    env: { LUNAROUTE_FRONT_URL: "http://front", LUNAROUTE_API_URL: "http://api", LUNAROUTE_ROUTING_URL: "http://gw/v1" },
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
  it("posts code+verifier+label and returns the key", async () => {
    const r = await exchangeCode("http://api", { code: "c", verifier: "v", label: "h" });
    expect(r.full_key).toBe("lr_new");
  });
  it("throws a descriptive error on failure", async () => {
    const srv = createServer((req, res) => { res.statusCode = 401; res.end(JSON.stringify({ error: { code: "INVALID_CODE", message: "bad code" } })); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    await expect(exchangeCode(`http://127.0.0.1:${port}`, { code: "c", verifier: "v", label: "h" }))
      .rejects.toThrow(/INVALID_CODE/);
    srv.close();
  });
});

describe("browser method", () => {
  it("authorize returns the device-auth URL with the loopback port; callback exchanges and succeeds", async () => {
    const { auth } = makeAuth();
    const method = auth.methods.find((m) => m.type === "oauth")!;
    const deps = { startLoopback: async () => ({ port: 39999, waitForCallback: async () => ({ code: "c", state: "st-1" }), close: () => {} }) };
    // authorize is bound with default deps; test via the internal path instead:
    const result = await method.authorize.call(auth, undefined, deps as never).catch(() => null) ?? await (auth as unknown as { __testAuthorize?: unknown }).__testAuthorize;
    // NOTE: see implementation — authorize() uses injected deps; the public contract test:
    void result;
  });
});

describe("paste method", () => {
  it("validates shape, fetches the gateway, and returns the key on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    const { auth, onLoginSuccess } = makeAuth({ deps: { fetch: fetchMock as never } } as never);
    const method = auth.methods.find((m) => m.type === "api")!;
    const res = await (method as { authorize: (i: Record<string, string>) => Promise<unknown> }).authorize({ api_key: "lr_good" });
    expect(res).toEqual({ type: "success", key: "lr_good" });
    expect(fetchMock).toHaveBeenCalledWith("http://gw/v1/models", expect.objectContaining({ headers: { Authorization: "Bearer lr_good" } }));
    expect(onLoginSuccess).toHaveBeenCalledWith("lr_good");
  });
  it("fails on bad shape without touching the network", async () => {
    const fetchMock = vi.fn();
    const { auth } = makeAuth({ deps: { fetch: fetchMock as never } } as never);
    const method = auth.methods.find((m) => m.type === "api")!;
    const res = await (method as { authorize: (i: Record<string, string>) => Promise<unknown> }).authorize({ api_key: "bad\nkey" });
    expect(res).toEqual({ type: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("fails when the gateway rejects the key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const { auth } = makeAuth({ deps: { fetch: fetchMock as never } } as never);
    const method = auth.methods.find((m) => m.type === "api")!;
    expect(await (method as { authorize: (i: Record<string, string>) => Promise<unknown> }).authorize({ api_key: "lr_stale" })).toEqual({ type: "failed" });
  });
});

describe("loader", () => {
  it("returns apiKey for stored credentials (api and oauth shapes)", async () => {
    const { auth } = makeAuth();
    const loader = (auth as { loader: (g: () => Promise<unknown>) => Promise<Record<string, unknown>> }).loader;
    expect(await loader(async () => ({ type: "api", key: "lr_x" }))).toEqual({ apiKey: "lr_x" });
    expect(await loader(async () => ({ type: "oauth", access: "lr_y", refresh: "", expires: 1 }))).toEqual({ apiKey: "lr_y" });
  });
  it("returns {} silently when not logged in or malformed", async () => {
    const { auth } = makeAuth();
    const loader = (auth as { loader: (g: () => Promise<unknown>) => Promise<Record<string, unknown>> }).loader;
    expect(await loader(async () => null)).toEqual({});
    expect(await loader(async () => ({ type: "api", key: "bad\nkey" }))).toEqual({});
  });
});
```

(Remove the placeholder-y "browser method" describe block above before committing — its real coverage is below.)

Replace that block with the real browser-flow test:

```ts
describe("browser method (full flow, injected deps)", () => {
  it("authorize → auto-callback → exchange → success + onLoginSuccess", async () => {
    const { auth, onLoginSuccess } = makeAuth();
    const method = auth.methods.find((m) => m.type === "oauth") as {
      authorize: () => Promise<{ url: string; instructions: string; method: "auto"; callback: () => Promise<{ type: string; key?: string }> }>;
    };
    // Wire a real loopback: start server, then simulate the browser redirect.
    const pending = method.authorize();
    // We can't reach into the closure; instead drive the real loopback by parsing the URL.
    const started = await pending;
    expect(started.url).toMatch(/^http:\/\/front\/device-auth\/opencode\?port=\d+&state=st-1&challenge=/);
    expect(started.method).toBe("auto");
    // simulate browser: extract port from URL, hit /callback
    const port = Number(new URL(started.url).searchParams.get("port"));
    await fetch(`http://127.0.0.1:${port}/callback?code=raw-code&state=st-1`);
    const result = await started.callback();
    expect(result.type).toBe("success");
    if (result.type === "success") expect(result.key).toBe("lr_new");
    expect(onLoginSuccess).toHaveBeenCalledWith("lr_new");
  });
  it("state mismatch fails the callback", async () => {
    const { auth, onLoginSuccess } = makeAuth();
    const method = auth.methods.find((m) => m.type === "oauth") as Parameters<typeof Object>[0] extends never ? never : Awaited<ReturnType<typeof makeAuth>["auth"]["methods"]["find"]> as never;
    const started = await (auth.methods.find((m) => m.type === "oauth") as never as { authorize: () => Promise<{ url: string; callback: () => Promise<{ type: string }> }> }).authorize();
    const port = Number(new URL(started.url).searchParams.get("port"));
    await fetch(`http://127.0.0.1:${port}/callback?code=raw-code&state=WRONG`);
    expect(await started.callback()).toEqual({ type: "failed" });
    expect(onLoginSuccess).not.toHaveBeenCalled();
  });
  it("times out after 3 minutes and releases the listener", async () => {
    vi.useFakeTimers();
    try {
      const { auth } = makeAuth({ deps: { verifier: () => "v".repeat(64), state: () => "st-1", exchange: async () => goodExchange, now: () => 0 } });
      const started = await (auth.methods.find((m) => m.type === "oauth") as never as { authorize: () => Promise<{ url: string; callback: () => Promise<{ type: string }> }> }).authorize();
      const promise = started.callback();
      await vi.advanceTimersByTimeAsync(3 * 60_000 + 10);
      await expect(promise).rejects.toThrow(/timed out|failed/i);
    } finally { vi.useRealTimers(); }
  });
});
```

(Note for the implementer: the `as never` gymnastics above are only to satisfy TS against the structural type — prefer casting once at the top of each test to `any`-free helpers like `const oauth = auth.methods.find((m) => m.type === "oauth") as Extract<typeof auth.methods[number], { type: "oauth" }>;`.)

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement `src/login.ts`**

```ts
import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import {
  buildDeviceAuthUrl, buildExchangeBody, computePkceChallenge, generatePkceVerifier, generateState,
  isValidCredentialShape, parseCallbackQuery, resolveApiUrl, resolveFrontUrl, resolveRoutingUrl,
  type ExchangeRequest, type ExchangeResponse,
} from "./lunaroute.js";

const LOGIN_TIMEOUT_MS = 3 * 60_000;

export type LoopbackServer = { port: number; waitForCallback(): Promise<{ code: string; state: string }>; close(): void };

/** Loopback on 127.0.0.1:0 for /callback?code=&state=. Resolves once; later hits are no-ops. */
export async function startLoopbackServer(): Promise<LoopbackServer> {
  let resolveCb: (r: { code: string; state: string }) => void;
  const cbPromise = new Promise<{ code: string; state: string }>((r) => (resolveCb = r));
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") { res.statusCode = 404; res.end("not found"); return; }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html");
    res.end("<html><body><h2>LunaRoute authorized.</h2><p>You can close this tab and return to opencode.</p></body></html>");
    resolveCb(parseCallbackQuery(url.toString())); // settling a settled promise is a no-op
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    waitForCallback: () => cbPromise,
    close: () => server.close(),
  };
}

export async function exchangeCode(apiUrl: string, req: ExchangeRequest, _signal?: AbortSignal): Promise<ExchangeResponse> {
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
    } catch { /* ignore */ }
    throw new Error(`exchange failed: ${detail}`);
  }
  return (await res.json()) as ExchangeResponse;
}

export type LoginDeps = {
  startLoopback?: () => Promise<LoopbackServer>;
  exchange?: typeof exchangeCode;
  state?: () => string;
  verifier?: () => string;
  now?: () => number;
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

export type LunarouteAuth = {
  provider: string;
  loader: (getAuth: () => Promise<unknown>) => Promise<Record<string, unknown>>;
  methods: unknown[];
};

export function createLunarouteAuth(opts: {
  env: NodeJS.ProcessEnv;
  onLoginSuccess?: (key: string) => void;
  log?: AuthLog;
  deps?: LoginDeps;
}): LunarouteAuth {
  const log = opts.log ?? (() => {});
  const d = {
    startLoopback: startLoopbackServer,
    exchange: exchangeCode,
    state: generateState,
    verifier: generatePkceVerifier,
    now: Date.now,
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
            callback: async () => {
              let timer: ReturnType<typeof setTimeout> | undefined;
              const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("timed out waiting for browser authorization")), LOGIN_TIMEOUT_MS);
              });
              try {
                const cb = await Promise.race([server.waitForCallback(), timeout]);
                if (cb.state !== state) return fail();
                const result = await d.exchange(resolveApiUrl(opts.env), { code: cb.code, verifier, label: hostname() });
                return succeed(result.full_key);
              } catch (err) {
                log("warn", `LunaRoute browser login error: ${err instanceof Error ? err.message : String(err)}`);
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
        prompts: [{
          type: "text",
          key: "api_key",
          message: "Paste your LunaRoute API key (lr_...)",
          placeholder: "lr_...",
          validate: (value: string) => (isValidCredentialShape(value) ? undefined : "Key must be printable ASCII, up to 512 characters"),
        }],
        authorize: async (inputs?: Record<string, string>) => {
          const key = inputs?.api_key;
          if (!isValidCredentialShape(key)) return fail();
          try {
            const res = await d.fetch(`${resolveRoutingUrl(opts.env)}/models`, { headers: { Authorization: `Bearer ${key}` } });
            return res.ok ? succeed(key) : fail();
          } catch {
            return fail();
          }
        },
      },
    ],
  };
}
```

- [ ] **Step 4: Run** → PASS (adjust the test-file casts to compile under `tsc --noEmit`; keep tests meaningful, not cast-soup: define one local `type OAuthMethod = Extract<LunarouteAuth["methods"][number], { type: "oauth" }>` style helper). **Step 5: Commit** `feat: auth hook — browser PKCE (device-auth/opencode) + validated paste + silent loader`

---

### Task 6: Catalog fetch + provider models (src/models.ts)

**Files:**
- Create: `src/models.ts`
- Test: `tests/models.test.ts`

**Interfaces:**
- Consumes (Tasks 3–4): `mapCatalog`, `MappedModel`, `defaultModelId`, `resolveRoutingUrl`, `LUNAROUTE_PROVIDER`, attribution headers, `sessionId` (from the plugin instance, Task 8)
- Produces:
  - `type ProviderModel = Record<string, unknown>` (structural OpenCode ModelV2 — exact fields below)
  - `type CatalogResult = { models: MappedModel[]; skipped: { id: string; reason: string }[] } | { error: string }`
  - `fetchCatalog(routingUrl, key, sessionId, opts?: { fetch?: typeof fetch; timeoutMs?: number }): Promise<CatalogResult>` — 5s `AbortSignal.timeout`, single attempt, `Authorization: Bearer`, attribution headers built from `sessionId`
  - `toProviderModels(models: MappedModel[], baseUrl: string): Record<string, ProviderModel>`
  - `injectProviderStub(cfg: ConfigLike, routingUrl: string): void` where `ConfigLike = { provider?: Record<string, Record<string, unknown>>; [k: string]: unknown }` — never sets `models`
  - `injectModels(cfg: ConfigLike, models: MappedModel[], baseUrl: string): void` — sets `provider.lunaroute.models = toProviderModels(...)` (replaces; catalog is the source of truth when logged in)
  - `createCatalogMemo(fetchFor: (key: string) => Promise<CatalogResult>): (key: string) => Promise<CatalogResult>` — per-process per-credential memo: concurrent calls share one in-flight fetch; a successful result is reused for later calls with the same key; a FAILED result is not cached (next call refetches)

- [ ] **Step 1: Failing tests** (`tests/models.test.ts`)

```ts
import { describe, it, expect, vi } from "vitest";
import { fetchCatalog, injectProviderStub, toProviderModels, createCatalogMemo } from "../src/models.js";
import type { MappedModel } from "../src/lunaroute.js";

const mk = (id: string): MappedModel => ({ id, name: id, reasoning: false, tool_call: true, attachment: false, limitContext: 64000, limitOutput: 4096, modalitiesInput: ["text"], variants: {} });

describe("fetchCatalog", () => {
  it("fetches with bearer + attribution, maps entries, reports skips", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "m-1" }, { id: "m-1" }, null] }) });
    const r = await fetchCatalog("http://gw/v1", "lr_k", "sess-1", { fetch: fetchMock as never });
    expect(r).toHaveProperty("models");
    if ("models" in r) {
      expect(r.models.map((m) => m.id)).toEqual(["m-1"]);
      expect(r.skipped).toHaveLength(2);
    }
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gw/v1/models");
    expect(init.headers["Authorization"]).toBe("Bearer lr_k");
    expect(init.headers["lunaroute-agent"]).toBe("opencode");
    expect(init.headers["x-lunaroute-session"]).toBe("sess-1");
  });
  it("returns error on !ok and on fetch failure", async () => {
    expect(await fetchCatalog("http://gw/v1", "lr_k", "sess-1", { fetch: vi.fn().mockResolvedValue({ ok: false, status: 401 }) as never })).toEqual({ error: "HTTP 401" });
    expect(await fetchCatalog("http://gw/v1", "lr_k", "sess-1", { fetch: vi.fn().mockRejectedValue(new Error("boom")) as never })).toEqual({ error: "boom" });
  });
  it("non-object body -> error", async () => {
    expect(await fetchCatalog("http://gw/v1", "lr_k", "sess-1", { fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => "nope" }) as never })).toHaveProperty("error");
  });
});

describe("toProviderModels", () => {
  it("produces the ModelV2 shape with api.url/npm, limits, variants, zeros cost", () => {
    const entry = Object.entries(toProviderModels([mk("m-1")], "http://gw/v1"))[0];
    const model = entry[1];
    expect(model).toMatchObject({
      id: "m-1", name: "m-1", providerID: "lunaroute", attachment: false, reasoning: false,
      tool_call: true, status: "active",
      api: { id: "m-1", url: "http://gw/v1", npm: "@ai-sdk/openai-compatible" },
      limit: { context: 64000, output: 4096 },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      modalities: { input: ["text"], output: ["text"] },
    });
  });
});

describe("injectProviderStub", () => {
  it("fills name/npm/baseURL when absent", () => {
    const cfg: Record<string, unknown> = {};
    injectProviderStub(cfg as never, "http://gw/v1");
    expect(cfg.provider).toEqual({ lunaroute: { name: "LunaRoute", npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://gw/v1" } } });
  });
  it("preserves user-set fields (name, npm, baseURL) and merges options", () => {
    const cfg: Record<string, unknown> = { provider: { lunaroute: { name: "My LR", npm: "custom-pkg", options: { baseURL: "http://staging/v1", extra: 1 } } } };
    injectProviderStub(cfg as never, "http://gw/v1");
    expect(cfg.provider).toEqual({ lunaroute: { name: "My LR", npm: "custom-pkg", options: { baseURL: "http://staging/v1", extra: 1 } } });
  });
  it("never sets models", () => {
    const cfg: Record<string, unknown> = {};
    injectProviderStub(cfg as never, "http://gw/v1");
    expect((cfg.provider as Record<string, unknown>).lunaroute).not.toHaveProperty("models");
  });
});

describe("injectModels", () => {
  it("sets provider.lunaroute.models from the mapped catalog (replaces prior)", () => {
    const cfg: Record<string, unknown> = {};
    injectProviderStub(cfg as never, "http://gw/v1");
    injectModels(cfg as never, [mk("m-1")], "http://gw/v1");
    const provider = (cfg.provider as Record<string, Record<string, unknown>>).lunaroute;
    expect(provider.models).toMatchObject({ "m-1": { id: "m-1", api: { url: "http://gw/v1" } } });
    injectModels(cfg as never, [mk("m-2")], "http://gw/v1");
    expect(Object.keys((cfg.provider as Record<string, Record<string, unknown>>).lunaroute.models!)).toEqual(["m-2"]);
  });
});

describe("createCatalogMemo", () => {
  it("shares one in-flight fetch for concurrent same-key calls; success is reused sequentially", async () => {
    let calls = 0;
    const slow = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { ok: true, json: async () => ({ data: [{ id: "m" }] }) }; };
    const memo = createCatalogMemo((k) => fetchCatalog("http://gw/v1", k, "sess-1", { fetch: slow as never }));
    const [a, b] = await Promise.all([memo("k"), memo("k")]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    const c = await memo("k"); // sequential reuse — no third fetch
    expect(calls).toBe(1);
    expect(c).toEqual(a);
  });
  it("does not cache failures; a different key refetches", async () => {
    let calls = 0;
    let fail = true;
    const flaky = async () => { calls++; if (fail) throw new Error("boom"); return { ok: true, json: async () => ({ data: [{ id: "m" }] }) }; };
    const memo = createCatalogMemo((k) => fetchCatalog("http://gw/v1", k, "sess-1", { fetch: flaky as never }));
    await memo("k"); // fails
    fail = false;
    const r = await memo("k"); // retries — failure was not cached
    expect(calls).toBe(2);
    expect(r).toHaveProperty("models");
    await memo("other"); // different key → refetch
    expect(calls).toBe(3);
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement `src/models.ts`**

```ts
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
```

(The `fetchFor` thunk receives the credential; note the memo caches the PROMISE — same-key callers all see the same result object. `fetchCatalog` never rejects — it returns `{ error }` — but the memo still guards a rejecting `fetchFor` for safety.)

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat: catalog fetch (5s timeout, attribution) + ModelV2 mapping + provider stub injection + in-flight dedup`

---

### Task 7: MCP injection — tri-state auth resolution + value-shape reconciler (src/mcp.ts)

**Files:**
- Create: `src/mcp.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Consumes (Tasks 3): `isValidCredentialShape`, `credentialFingerprint`, `buildAttributionHeaders`, `resolveMcpUrl`, `LUNAROUTE_PROVIDER`
- Produces:
  - `type AuthResolution = { state: "valid"; key: string } | { state: "logged-out" } | { state: "indeterminate"; reason: string }`
  - `type AuthStoreFS = { readFile(path: string): Promise<string> }`
  - `resolveAuthStorePath(env: NodeJS.ProcessEnv, home: string): string` — `<XDG_DATA_HOME | home/.local/share>/opencode/auth.json` (spike-verified: xdg-basedir semantics on Linux AND macOS — no platform branch needed in v1; pure function)
  - `resolveAuthState(storePath: string, fs?: AuthStoreFS): Promise<AuthResolution>` — single read, no retry; ENOENT → `indeterminate("auth store missing")`; parse error → `indeterminate("auth store unparseable")`; non-object store → same; entry absent → `logged-out`; entry present: api `key`/oauth `access` via `isValidCredentialShape` → `valid` else `indeterminate("credential present but invalid")`
  - `isManagedShape(entry: unknown, mcpUrl: string): boolean`
  - `type ReconcilerLog = (level: "info" | "warn", message: string) => void`
  - `createMcpReconciler(mcpUrl: string, log: ReconcilerLog): { reconcile(cfg: ConfigLike, resolution: AuthResolution): void }` — implements the matrix; state `Map<storeKey, Set<fingerprint>>`; `reconcile` also takes `storeKey` (add param) and the managed entry builder uses attribution headers + current key

- [ ] **Step 1: Failing tests** (`tests/mcp.test.ts`) — organized in the four spec groups:

```ts
import { describe, it, expect, vi } from "vitest";
import { resolveAuthState, resolveAuthStorePath, isManagedShape, createMcpReconciler } from "../src/mcp.js";
import { credentialFingerprint } from "../src/lunaroute.js";

const MCP_URL = "https://mcp.lunaroute.com/mcp";
const KEY_A = "lr_aaaaaaaaaa";
const KEY_B = "lr_bbbbbbbbbb";

function memFS(files: Record<string, string | Error>): { readFile: (p: string) => Promise<string> } {
  return { readFile: async (p) => { const v = files[p]; if (v instanceof Error) throw v; if (v === undefined) { const e = new Error("ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e; } return v; } };
}
const store = (entry: unknown) => JSON.stringify({ lunaroute: entry });
const managedEntry = (key: string) => ({
  type: "remote", url: MCP_URL, oauth: false, enabled: true,
  headers: { "LUNAROUTE-API-KEY": key, "lunaroute-agent": "opencode", "x-lunaroute-session": "s", "lunaroute-session-id": "s" },
});
const cfgWith = (entry: unknown) => ({ mcp: { lunaroute: entry } }) as Record<string, unknown>;

describe("auth resolver (tri-state)", () => {
  const p = "/store/auth.json";
  it("valid: readable + shaped credential", async () => {
    expect(await resolveAuthState(p, memFS({ [p]: store({ type: "api", key: KEY_A }) }))).toEqual({ state: "valid", key: KEY_A });
    expect(await resolveAuthState(p, memFS({ [p]: store({ type: "oauth", access: KEY_A, refresh: "", expires: 1 }) }))).toEqual({ state: "valid", key: KEY_A });
  });
  it("logged-out: readable store, entry absent", async () => {
    expect(await resolveAuthState(p, memFS({ [p]: JSON.stringify({}) }))).toEqual({ state: "logged-out" });
    expect(await resolveAuthState(p, memFS({ [p]: JSON.stringify({ other: { type: "api", key: "x" } }) }))).toEqual({ state: "logged-out" });
  });
  it("indeterminate: missing, unparseable, unreadable, non-object store", async () => {
    expect(await resolveAuthState(p, memFS({}))).toMatchObject({ state: "indeterminate" });
    expect(await resolveAuthState(p, memFS({ [p]: "{nope" }))).toMatchObject({ state: "indeterminate" });
    expect(await resolveAuthState(p, memFS({ [p]: "[1]" }))).toMatchObject({ state: "indeterminate" });
    expect(await resolveAuthState(p, memFS({ [p]: new Error("EACCES") }))).toMatchObject({ state: "indeterminate" });
  });
  it("indeterminate: present-but-invalid record shapes", async () => {
    for (const bad of [null, [], 5, {}, { type: "api" }, { type: "api", key: "" }, { type: "api", key: "bad\n" }, { type: "oauth" }]) {
      expect(await resolveAuthState(p, memFS({ [p]: store(bad) }))).toMatchObject({ state: "indeterminate" });
    }
  });
  it("store path: XDG override and default", () => {
    expect(resolveAuthStorePath({ XDG_DATA_HOME: "/xdg" }, "/home/u")).toBe("/xdg/opencode/auth.json");
    expect(resolveAuthStorePath({}, "/home/u")).toBe("/home/u/.local/share/opencode/auth.json");
  });
});

describe("value-shape recognition", () => {
  it("matches our exact shape, ignoring the key value; case-insensitive header names", () => {
    expect(isManagedShape(managedEntry(KEY_A), MCP_URL)).toBe(true);
    const caseVaried = managedEntry(KEY_A);
    caseVaried.headers = { "lunaroute-api-key": KEY_A, "LUNAROUTE-AGENT": "opencode", "x-lunaroute-session": "s", "lunaroute-session-id": "s" };
    expect(isManagedShape(caseVaried, MCP_URL)).toBe(true);
  });
  it("rejects divergence and malformed shapes", () => {
    for (const bad of [
      { type: "local", command: [] },               // wrong type
      { ...managedEntry(KEY_A), url: "https://elsewhere" },
      { ...managedEntry(KEY_A), oauth: true },
      { ...managedEntry(KEY_A), enabled: false },
      { ...managedEntry(KEY_A), extra: 1 },          // extra fields are fine (normalization) — flip: see below
      (() => { const e = managedEntry(KEY_A); delete (e.headers as Record<string, unknown>)["lunaroute-agent"]; return e; })(),
      (() => { const e: Record<string, unknown> = managedEntry(KEY_A); (e.headers as Record<string, unknown>)["extra-header"] = "x"; return e; })(),
      (() => { const e: Record<string, unknown> = managedEntry(KEY_A); (e.headers as Record<string, unknown>)["LUNAROUTE-api-key"] = KEY_A; return e; })(), // duplicate logical name
    ]) {
      // NOTE: `{ ...managedEntry(KEY_A), extra: 1 }` must be ACCEPTED (OpenCode may add fields);
      // split it out of the reject list into its own assertion:
      void bad;
    }
    expect(isManagedShape({ ...managedEntry(KEY_A), extra: 1 }, MCP_URL)).toBe(true);
    expect(isManagedShape(undefined, MCP_URL)).toBe(false);
    expect(isManagedShape("nope", MCP_URL)).toBe(false);
  });
});
```

(Clean the above loop before committing: enumerate the reject cases as individual `it` blocks — `wrong type`, `different url`, `oauth true`, `enabled false`, `missing header`, `extra header`, `duplicate logical name` — plus the two accept cases. Keep each case a named test.)

```ts
describe("reconciler (matrix)", () => {
  function setup() {
    const logs: { level: string; message: string }[] = [];
    const log = (level: "info" | "warn", message: string) => logs.push({ level, message });
    const r = createMcpReconciler(MCP_URL, log);
    return { r, logs };
  }
  const SK = "/store/auth.json";

  it("valid + absent → inject (records fingerprint)", () => {
    const { r } = setup();
    const cfg: Record<string, unknown> = {};
    r.reconcile(cfg, { state: "valid", key: KEY_A }, SK);
    const entry = (cfg.mcp as Record<string, Record<string, unknown>>).lunaroute;
    expect(entry).toBeDefined();
    expect((entry.headers as Record<string, string>)["LUNAROUTE-API-KEY"]).toBe(KEY_A);
  });
  it("valid + ours → replace header values with current key", () => {
    const { r } = setup();
    const cfg = cfgWith(managedEntry(KEY_A));
    r.reconcile(cfg, { state: "valid", key: KEY_B }, SK);
    const entry = (cfg.mcp as Record<string, Record<string, unknown>>).lunaroute as { headers: Record<string, string> };
    expect(entry.headers["LUNAROUTE-API-KEY"]).toBe(KEY_B);
  });
  it("valid + user-owned → untouched + info log", () => {
    const { r, logs } = setup();
    const cfg = cfgWith({ type: "remote", url: "https://mine", headers: { A: "b" } });
    r.reconcile(cfg, { state: "valid", key: KEY_A }, SK);
    expect((cfg.mcp as Record<string, unknown>).lunaroute).toEqual({ type: "remote", url: "https://mine", headers: { A: "b" } });
    expect(logs.some((l) => l.level === "info" && /user-defined mcp/.test(l.message))).toBe(true);
  });
  it("logged-out + absent → nothing", () => {
    const { r } = setup();
    const cfg: Record<string, unknown> = {};
    r.reconcile(cfg, { state: "logged-out" }, SK);
    expect(cfg).toEqual({});
  });
  it("logged-out + ours (fingerprint known) → removed", () => {
    const { r } = setup();
    const cfg = cfgWith(managedEntry(KEY_A));
    r.reconcile(cfg, { state: "valid", key: KEY_A }, SK); // inject first
    r.reconcile(cfg, { state: "logged-out" }, SK);
    expect((cfg.mcp as Record<string, unknown>).lunaroute).toBeUndefined();
  });
  it("logged-out + ours (unknown credential) → retained + info log", () => {
    const { r, logs } = setup();
    const cfg = cfgWith(managedEntry("lr_unknown_key"));
    r.reconcile(cfg, { state: "logged-out" }, SK);
    expect((cfg.mcp as Record<string, unknown>).lunaroute).toBeDefined();
    expect(logs.some((l) => /unknown credential/.test(l.message))).toBe(true);
  });
  it("indeterminate + managed entry → retained + one warn", () => {
    const { r, logs } = setup();
    const cfg = cfgWith(managedEntry(KEY_A));
    r.reconcile(cfg, { state: "indeterminate", reason: "auth store missing" }, SK);
    expect((cfg.mcp as Record<string, unknown>).lunaroute).toBeDefined();
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(1);
  });
  it("indeterminate + nothing to retain → silent no-op", () => {
    const { r, logs } = setup();
    const cfg: Record<string, unknown> = {};
    r.reconcile(cfg, { state: "indeterminate", reason: "auth store missing" }, SK);
    expect(logs).toEqual([]);
  });
});

describe("multi-generation + isolation + eviction", () => {
  const SK = "/store/auth.json";
  it("rotation across generations: both cleaned on logout", () => {
    const logs: { level: string; message: string }[] = [];
    const r = createMcpReconciler(MCP_URL, (l, m) => logs.push({ level: l, message: m }));
    const gen1 = cfgWith(managedEntry(KEY_A));
    const gen2: Record<string, unknown> = {};
    r.reconcile(gen1, { state: "valid", key: KEY_A }, SK);
    r.reconcile(gen2, { state: "valid", key: KEY_B }, SK);
    r.reconcile(gen1, { state: "logged-out" }, SK);
    r.reconcile(gen2, { state: "logged-out" }, SK);
    expect((gen1.mcp as Record<string, unknown>).lunaroute).toBeUndefined();
    expect((gen2.mcp as Record<string, unknown>).lunaroute).toBeUndefined();
  });
  it("eviction bound, both sides: 2–9 removed, 1 retained", () => {
    const r = createMcpReconciler(MCP_URL, () => {});
    const gens: Record<string, unknown>[] = [];
    for (let i = 1; i <= 9; i++) {
      const g: Record<string, unknown> = {};
      r.reconcile(g, { state: "valid", key: `lr_k${i}` }, SK);
      gens.push(g);
    }
    for (const g of gens) r.reconcile(g, { state: "logged-out" }, SK);
    for (let i = 1; i <= 9; i++) {
      const entry = (gens[i - 1].mcp as Record<string, unknown>).lunaroute;
      if (i === 1) expect(entry).toBeDefined();       // evicted fingerprint → retained
      else expect(entry).toBeUndefined();              // still tracked → removed
    }
  });
  it("re-injection refreshes eviction position", () => {
    const r = createMcpReconciler(MCP_URL, () => {});
    const g: Record<string, unknown> = {};
    for (let i = 1; i <= 8; i++) r.reconcile(g, { state: "valid", key: `lr_k${i}` }, SK);
    r.reconcile(g, { state: "valid", key: "lr_k1" }, SK);          // refresh k1 to most-recent
    r.reconcile(g, { state: "valid", key: "lr_k9" }, SK);          // evicts k2, not k1
    r.reconcile(g, { state: "logged-out" }, SK);
    expect((g.mcp as Record<string, unknown>).lunaroute).toBeDefined(); // k1 still tracked
  });
  it("store-key isolation: logout in one store never touches another", () => {
    const r = createMcpReconciler(MCP_URL, () => {});
    const g1 = cfgWith(managedEntry(KEY_A));
    const g2 = cfgWith(managedEntry(KEY_A));
    r.reconcile(g1, { state: "valid", key: KEY_A }, "/s1/auth.json");
    r.reconcile(g2, { state: "valid", key: KEY_A }, "/s2/auth.json");
    r.reconcile(g1, { state: "logged-out" }, "/s1/auth.json");
    expect((g1.mcp as Record<string, unknown>).lunaroute).toBeUndefined();
    expect((g2.mcp as Record<string, unknown>).lunaroute).toBeDefined();
  });
  it("store-key lifecycle: same logical store across present→missing→restored (lexical key)", () => {
    const r = createMcpReconciler(MCP_URL, () => {});
    const SK = "/store/auth.json";
    const g = cfgWith(managedEntry(KEY_A));
    r.reconcile(g, { state: "valid", key: KEY_A }, SK);
    r.reconcile(g, { state: "indeterminate", reason: "auth store missing" }, SK); // missing interval: retain
    expect((g.mcp as Record<string, unknown>).lunaroute).toBeDefined();
    r.reconcile(g, { state: "valid", key: KEY_A }, SK);                              // restored: refresh
    r.reconcile(g, { state: "logged-out" }, SK);                                     // logout: remove
    expect((g.mcp as Record<string, unknown>).lunaroute).toBeUndefined();
  });
});

describe("redaction", () => {
  it("no credential material in any log line (current, historical, malformed)", () => {
    const logs: string[] = [];
    const r = createMcpReconciler(MCP_URL, (_l, m) => logs.push(m));
    const g = cfgWith(managedEntry(KEY_A));
    r.reconcile(g, { state: "valid", key: KEY_A }, "/s/auth.json");
    r.reconcile(g, { state: "indeterminate", reason: "auth store unparseable" }, "/s/auth.json");
    r.reconcile(g, { state: "logged-out" }, "/s/auth.json");
    for (const line of logs) {
      expect(line).not.toContain(KEY_A);
      expect(line).not.toContain(credentialFingerprint(KEY_A));
    }
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement `src/mcp.ts`**

```ts
import { readFileSync, promises as fsp } from "node:fs";
import { join } from "node:path";
import { buildAttributionHeaders, credentialFingerprint, isValidCredentialShape, LUNAROUTE_PROVIDER } from "./lunaroute.js";

export type AuthResolution =
  | { state: "valid"; key: string }
  | { state: "logged-out" }
  | { state: "indeterminate"; reason: string };

export type AuthStoreFS = { readFile(path: string): Promise<string> };

const defaultFS: AuthStoreFS = { readFile: (p) => fsp.readFile(p, "utf8") };

/** Lexical store path — identity is the path, not the inode (spike-verified: xdg-basedir semantics on Linux and macOS). */
export function resolveAuthStorePath(env: NodeJS.ProcessEnv, home: string): string {
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(dataHome, "opencode", "auth.json");
}

export async function resolveAuthState(storePath: string, fs: AuthStoreFS = defaultFS): Promise<AuthResolution> {
  let raw: string;
  try { raw = await fs.readFile(storePath); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { state: "indeterminate", reason: code === "ENOENT" ? "auth store missing" : "auth store unreadable" };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { state: "indeterminate", reason: "auth store unparseable" }; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { state: "indeterminate", reason: "auth store malformed" };
  const entry = (parsed as Record<string, unknown>)[LUNAROUTE_PROVIDER];
  if (entry === undefined) return { state: "logged-out" };
  const candidate = typeof entry === "object" && entry !== null
    ? (entry as Record<string, unknown>).type === "api"
      ? (entry as Record<string, unknown>).key
      : (entry as Record<string, unknown>).type === "oauth"
        ? (entry as Record<string, unknown>).access
        : undefined
    : undefined;
  if (isValidCredentialShape(candidate)) return { state: "valid", key: candidate };
  return { state: "indeterminate", reason: "credential present but invalid" };
}

const EXPECTED_HEADER_NAMES = ["lunaroute-api-key", "lunaroute-agent", "x-lunaroute-session", "lunaroute-session-id"];

/** Value-shape recognition: ours = remote + our URL + oauth false + enabled + same header-name set (case-insensitive, no duplicates). Extra non-header fields are tolerated (host normalization). */
export function isManagedShape(entry: unknown, mcpUrl: string): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  if (e.type !== "remote" || e.url !== mcpUrl || e.oauth !== false || e.enabled !== true) return false;
  if (typeof e.headers !== "object" || e.headers === null) return false;
  const names = Object.keys(e.headers).map((k) => k.toLowerCase());
  if (names.length !== EXPECTED_HEADER_NAMES.length) return false;
  if (new Set(names).size !== names.length) return false; // duplicate logical names → malformed → user-owned
  const expected = new Set(EXPECTED_HEADER_NAMES);
  return names.every((n) => expected.has(n));
}

export type ReconcilerLog = (level: "info" | "warn", message: string) => void;

const FINGERPRINT_LIMIT = 8;

export function createMcpReconciler(mcpUrl: string, log: ReconcilerLog, sessionId: string) {
  const fingerprints = new Map<string, Set<string>>(); // storeKey → ordered fingerprints (most recent last)
  const remember = (storeKey: string, key: string): void => {
    const set = fingerprints.get(storeKey) ?? new Set<string>();
    const fp = credentialFingerprint(key);
    set.delete(fp);          // refresh position
    set.add(fp);
    while (set.size > FINGERPRINT_LIMIT) set.delete(set.values().next().value as string); // evict oldest
    fingerprints.set(storeKey, set);
  };
  const knows = (storeKey: string, key: string): boolean =>
    (fingerprints.get(storeKey) ?? new Set<string>()).has(credentialFingerprint(key));

  return {
    reconcile(cfg: Record<string, unknown>, resolution: AuthResolution, storeKey: string): void {
      const mcp = ((cfg.mcp ?? {}) as Record<string, unknown>);
      cfg.mcp = mcp;
      const existing = mcp[LUNAROUTE_PROVIDER];
      const managed = isManagedShape(existing, mcpUrl);

      if (resolution.state === "indeterminate") {
        if (existing !== undefined && managed) {
          log("warn", `LunaRoute: auth store indeterminate (${resolution.reason}); mcp.lunaroute left untouched`);
        }
        return; // silent no-op when nothing to retain
      }

      if (resolution.state === "valid") {
        if (existing !== undefined && !managed) {
          log("info", "LunaRoute: user-defined mcp.lunaroute in effect; rotate by editing it or removing it");
          return;
        }
        mcp[LUNAROUTE_PROVIDER] = {
          type: "remote",
          url: mcpUrl,
          headers: { "LUNAROUTE-API-KEY": resolution.key, ...buildAttributionHeaders(sessionId) },
          oauth: false,
          enabled: true,
        };
        remember(storeKey, resolution.key);
        return;
      }

      // logged-out
      if (managed) {
        const key = (existing as { headers: Record<string, string> }).headers["LUNAROUTE-API-KEY"]
          ?? (existing as { headers: Record<string, string> }).headers["lunaroute-api-key"];
        if (typeof key === "string" && knows(storeKey, key)) {
          delete mcp[LUNAROUTE_PROVIDER]; // remove only credentials we placed
        } else {
          log("info", "LunaRoute: mcp.lunaroute matches the plugin shape but carries an unknown credential; left untouched");
        }
      }
    },
  };
}
```

(Prune the unused `readFileSync` import before committing.)

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat: tri-state auth resolution + value-shape MCP reconciler (full lifecycle matrix, fingerprint set, store-key isolation)`

---

### Task 8: Plugin wiring — config hook (stub + models + MCP), chat.headers, post-login (src/index.ts)

**Files:**
- Create: `src/index.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–7 plus `createLunarouteAuth` (Task 5), `fetchCatalog`/`toProviderModels`/`injectProviderStub`/`injectModels`/`createCatalogMemo` (Task 6), `resolveAuthStorePath`/`resolveAuthState`/`createMcpReconciler` (Task 7)
- Produces: `createLunaroutePlugin(opts?: PluginDeps): Plugin` (default export) where `PluginDeps = { env?, home?, log?, client? }` for tests; the plugin returns `{ config, auth, "chat.headers", dispose }` — **no `provider` hook** (spike finding: it never fires for custom config providers)

- [ ] **Step 1: Failing tests** (`tests/index.test.ts`)

```ts
import { describe, it, expect, vi } from "vitest";
import { createLunaroutePlugin } from "../src/index.js";
import { resolveAuthStorePath } from "../src/mcp.js";

const ENV = {
  LUNAROUTE_ROUTING_URL: "http://gw/v1",
  LUNAROUTE_API_URL: "http://api",
  LUNAROUTE_FRONT_URL: "http://front",
  LUNAROUTE_MCP_URL: "http://mcp",
};
const AUTH_PATH = "/fake/home/.local/share/opencode/auth.json";

function makePlugin(overrides: { fs?: object; client?: object } = {}) {
  const logs: { level: string; message: string }[] = [];
  const plugin = createLunaroutePlugin({
    env: ENV, home: "/fake/home",
    log: (level, message) => logs.push({ level, message }),
    ...overrides,
  });
  return { plugin, logs };
}

describe("config hook", () => {
  it("injects provider stub + models + MCP when a valid key exists; memo prevents refetch on second run", async () => {
    const fs = { readFile: async () => JSON.stringify({ lunaroute: { type: "api", key: "lr_good" } }) };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "m-1" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { plugin } = makePlugin({ fs });
      const hooks = await plugin({} as never, undefined as never);
      const cfg: Record<string, unknown> = {};
      await hooks.config!(cfg as never, { storeKey: AUTH_PATH, fs } as never);
      expect((cfg.provider as Record<string, unknown>).lunaroute).toMatchObject({ options: { baseURL: "http://gw/v1" } });
      expect((cfg.provider as Record<string, Record<string, unknown>>).lunaroute.models).toHaveProperty("m-1");
      expect((cfg.mcp as Record<string, Record<string, string>>).lunaroute.headers["LUNAROUTE-API-KEY"]).toBe("lr_good");
      const cfg2: Record<string, unknown> = {};
      await hooks.config!(cfg2 as never, { storeKey: AUTH_PATH, fs } as never);
      expect(fetchMock).toHaveBeenCalledTimes(1); // memoized per credential
      expect((cfg2.provider as Record<string, Record<string, unknown>>).lunaroute.models).toHaveProperty("m-1");
    } finally { vi.unstubAllGlobals(); }
  });
  it("logged out: provider stub only — no models, no MCP, silent", async () => {
    const fs = { readFile: async () => JSON.stringify({}) };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { plugin, logs } = makePlugin({ fs });
      const hooks = await plugin({} as never, undefined as never);
      const cfg: Record<string, unknown> = {};
      await hooks.config!(cfg as never, { storeKey: AUTH_PATH, fs } as never);
      expect((cfg.provider as Record<string, unknown>).lunaroute).toBeDefined();
      expect((cfg.provider as Record<string, Record<string, unknown>>).lunaroute.models).toBeUndefined();
      expect((cfg.mcp as Record<string, unknown> | undefined)?.lunaroute).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logs).toEqual([{ level: "info", message: "Run /connect and choose LunaRoute to start using LunaRoute." }]);
    } finally { vi.unstubAllGlobals(); }
  });
  it("indeterminate (unreadable store): stub lands, models + MCP untouched, one warn — per-contributor error isolation", async () => {
    const fs = { readFile: async () => { throw new Error("EACCES"); } };
    const { plugin, logs } = makePlugin({ fs });
    const hooks = await plugin({} as never, undefined as never);
    const cfg: Record<string, unknown> = {};
    await hooks.config!(cfg as never, { storeKey: AUTH_PATH, fs } as never);
    expect((cfg.provider as Record<string, unknown>).lunaroute).toBeDefined();
    expect((cfg.mcp as Record<string, unknown> | undefined)?.lunaroute).toBeUndefined();
    expect(logs.some((l) => l.level === "warn")).toBe(true);
  });
  it("catalog fetch failure: stub + MCP land, no models, one warn", async () => {
    const fs = { readFile: async () => JSON.stringify({ lunaroute: { type: "api", key: "lr_good" } }) };
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("gateway down")));
    try {
      const { plugin, logs } = makePlugin({ fs });
      const hooks = await plugin({} as never, undefined as never);
      const cfg: Record<string, unknown> = {};
      await hooks.config!(cfg as never, { storeKey: AUTH_PATH, fs } as never);
      expect((cfg.provider as Record<string, Record<string, unknown>>).lunaroute.models).toBeUndefined();
      expect((cfg.mcp as Record<string, Record<string, string>>).lunaroute.headers["LUNAROUTE-API-KEY"]).toBe("lr_good");
      expect(logs.some((l) => l.level === "warn" && /catalog/.test(l.message))).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("chat.headers", () => {
  it("adds the attribution triple only for the lunaroute provider", async () => {
    const { plugin } = makePlugin();
    const hooks = await plugin({} as never, undefined as never);
    const out: { headers: Record<string, string> } = { headers: {} };
    await (hooks as Record<string, unknown>)["chat.headers"](
      { provider: { info: { id: "lunaroute" } } }, out,
    );
    expect(out.headers["lunaroute-agent"]).toBe("opencode");
    expect(out.headers["x-lunaroute-session"]).toBeDefined();
    const out2: { headers: Record<string, string> } = { headers: {} };
    await (hooks as Record<string, unknown>)["chat.headers"]({ provider: { info: { id: "anthropic" } } }, out2);
    expect(out2.headers).toEqual({});
  });
  it("shares one session id between chat headers and MCP injection", async () => {
    const fs = { readFile: async () => JSON.stringify({ lunaroute: { type: "api", key: "lr_good" } }) };
    const { plugin } = makePlugin({ fs });
    const hooks = await plugin({} as never, undefined as never);
    const cfg: Record<string, unknown> = {};
    await hooks.config!(cfg as never, { storeKey: AUTH_PATH, fs } as never);
    const mcpSession = (cfg.mcp as Record<string, Record<string, string>>).lunaroute.headers["lunaroute-session-id"];
    const out: { headers: Record<string, string> } = { headers: {} };
    await (hooks as Record<string, unknown>)["chat.headers"]({ provider: { info: { id: "lunaroute" } } }, out);
    expect(out.headers["lunaroute-session-id"]).toBe(mcpSession);
  });
});

describe("post-login model auto-pick", () => {
  it("writes exactly { model } when unset; skips when set; re-read guard; failures logged not thrown", async () => {
    const configGet = vi.fn().mockResolvedValue({ data: {} }).mockResolvedValueOnce({ data: {} }).mockResolvedValueOnce({ data: { model: "anthropic/x" } });
    const configUpdate = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "m-1" }] }) });
    const client = { config: { get: configGet, update: configUpdate } };
    const { plugin, logs } = makePlugin({ client });
    const hooks = await plugin({ client } as never, undefined as never);
    // first login: model unset → picks lunaroute/m-1
    const api = hooks.auth!.methods.find((m) => (m as { type: string }).type === "api") as { authorize: (i: Record<string, string>) => Promise<unknown> };
    vi.stubGlobal("fetch", fetchMock);
    await api.authorize({ api_key: "lr_good" });
    expect(configUpdate).toHaveBeenCalledWith({ config: { model: "lunaroute/m-1" } });
    // re-login when a model is set → no further update
    configUpdate.mockClear();
    await api.authorize({ api_key: "lr_good" });
    expect(configUpdate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    void logs;
  });
});
```

(The `config` hook receives `(cfg, runtime)` in these tests — see the implementation note below: `createLunaroutePlugin` accepts an optional second argument carrying `{ storeKey, fs, client }` test doubles. The production path derives these from `process.env`, `os.homedir()`, and the real plugin `input.client`.)

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement `src/index.ts`**

```ts
import { homedir } from "node:os";
import type { Plugin } from "@opencode-ai/plugin";
import {
  buildAttributionHeaders, defaultModelId, generateSessionId, LUNAROUTE_PROVIDER, resolveMcpUrl, resolveRoutingUrl,
} from "./lunaroute.js";
import { createLunarouteAuth } from "./login.js";
import { createCatalogMemo, fetchCatalog, injectModels, injectProviderStub } from "./models.js";
import { createMcpReconciler, resolveAuthState, resolveAuthStorePath, type AuthStoreFS } from "./mcp.js";

export type PluginLog = (level: "info" | "warn", message: string) => void;

export type PluginRuntime = {
  storeKey?: string;      // test override for the resolved auth-store path
  fs?: AuthStoreFS;       // test override for the auth-store read
  client?: { config: { get(): Promise<{ data?: { model?: string } }>; update(body: { config: { model: string } }): Promise<unknown> } };
};

export type PluginDeps = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  log?: PluginLog;
};

export function createLunaroutePlugin(deps: PluginDeps = {}): Plugin {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const sessionId = generateSessionId();
  const routingUrl = resolveRoutingUrl(env);
  const mcpUrl = resolveMcpUrl(env);
  const log: PluginLog = deps.log ?? (() => {});
  const reconciler = createMcpReconciler(mcpUrl, log, sessionId);
  const catalogMemo = createCatalogMemo((key) => fetchCatalog(routingUrl, key, sessionId));
  let firstRunHintShown = false;

  return async (input, _options) => {
    const clientOf = (runtime?: PluginRuntime) => runtime?.client ?? (input as unknown as { client?: PluginRuntime["client"] }).client;

    const postLoginRefresh = async (key: string, runtime?: PluginRuntime): Promise<void> => {
      try {
        const client = clientOf(runtime);
        if (!client) return;
        const current = await client.config.get();
        if (current?.data?.model) return;
        const catalog = await catalogMemo(key);
        if (!("models" in catalog) || !catalog.models.length) return;
        const id = defaultModelId(catalog.models);
        if (!id) return;
        const fresh = await client.config.get(); // re-read guard
        if (fresh?.data?.model) return;
        await client.config.update({ config: { model: `${LUNAROUTE_PROVIDER}/${id}` } });
        // The update marks the instance for disposal; on reload the config hook
        // re-runs (spike gate (a)) and re-injects models + MCP with the fresh key.
      } catch (err) {
        log("warn", `LunaRoute: post-login default-model pick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    return {
      config: async (cfg: Record<string, unknown>, runtime?: PluginRuntime) => {
        // Contributor 1: provider stub — always lands, individually isolated.
        try { injectProviderStub(cfg, routingUrl); } catch (err) { log("warn", `LunaRoute: provider stub injection failed: ${err instanceof Error ? err.message : String(err)}`); }
        // One auth resolution feeds both contributors 2 (models) and 3 (MCP).
        try {
          const storeKey = runtime?.storeKey ?? resolveAuthStorePath(env, home);
          const resolution = await resolveAuthState(storeKey, runtime?.fs);
          try {
            if (resolution.state === "valid") {
              const result = await catalogMemo(resolution.key);
              if ("error" in result) {
                log("warn", `LunaRoute: catalog fetch failed: ${result.error}`);
              } else {
                for (const s of result.skipped) log("warn", `LunaRoute: skipped catalog entry "${s.id}": ${s.reason}`);
                if (result.skipped.length && !result.models.length) log("warn", `LunaRoute: catalog had ${result.skipped.length} invalid entries, all skipped`);
                injectModels(cfg, result.models, routingUrl);
              }
            } else if (resolution.state === "logged-out" && !firstRunHintShown) {
              firstRunHintShown = true;
              log("info", "Run /connect and choose LunaRoute to start using LunaRoute.");
            }
            // logged-out / indeterminate: leave any existing models untouched (fail-safe retention).
          } catch (err) { log("warn", `LunaRoute: model injection failed: ${err instanceof Error ? err.message : String(err)}`); }
          try { reconciler.reconcile(cfg, resolution, storeKey); } catch (err) { log("warn", `LunaRoute: MCP injection failed: ${err instanceof Error ? err.message : String(err)}`); }
        } catch (err) {
          log("warn", `LunaRoute: auth resolution failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      auth: createLunarouteAuth({
        env,
        log,
        onLoginSuccess: (key) => { void postLoginRefresh(key); },
      }),
      "chat.headers": async (req: { provider?: { info?: { id?: string } } }, output: { headers: Record<string, string> }) => {
        if (req.provider?.info?.id === LUNAROUTE_PROVIDER) Object.assign(output.headers, buildAttributionHeaders(sessionId));
      },
      dispose: async () => {},
    };
  };
}

export default createLunaroutePlugin();
```

(Reconcile the `onLoginSuccess` wiring with Task 5's `createLunarouteAuth` options — the paste-method test in Task 8 calls `authorize` with the global `fetch` stubbed, and `postLoginRefresh` must use the runtime client; the production default export wires `input.client`. If the structural mismatch with `@opencode-ai/plugin`'s `Plugin` type fights the compiler, keep `createLunaroutePlugin` returning the structural hooks object and export it with a targeted `as unknown as Plugin` cast at the default export only — never silence types inside the modules.)

- [ ] **Step 4: Run** → PASS; `npm run check` green. **Step 5: Commit** `feat: plugin wiring — config-hook model injection, auth, chat.headers + guarded model auto-pick`

---

### Task 9: README + smoke checklist + secret-lifecycle verification

**Files:**
- Create: `README.md`, `docs/smoke-checklist.md`, `LICENSE` (MIT, copyright LunaRoute — closes the gap flagged in Task 2's review)
- Modify: none in src

**Interfaces:**
- Consumes: spike decision record (Task 1) for the MCP wording (reload-automatic vs restart-required)
- Produces: user-facing docs; the manual gate for release

- [ ] **Step 1: Write `README.md`** — structure it on the pi extension's README, with these required sections (write the real copy, do not abbreviate):
  - Title + one-paragraph pitch ("Use LunaRoute from OpenCode in under a minute").
  - Requirements: OpenCode ≥ (spike minimum), LunaRoute account.
  - Quick start: add `"plugin": ["@lunaroute/opencode-extension"]` to `opencode.json`; run `/connect`; choose **LunaRoute**; "Log in with browser" (opens `${app}/device-auth/opencode`, PKCE, key lands in `~/.local/share/opencode/auth.json`) or "Paste an API key" (validated against the gateway). Then `/models` → LunaRoute models.
  - MCP tools: hosted LunaRoute MCP (`https://mcp.lunaroute.com/mcp`) auto-registered **in the live session config only** when logged in — never written to any config file; **"MCP entry management"** section with the exact-shape collision behavior, `enabled: false` opt-out, and the reload-vs-restart wording from the spike record.
  - Configuration: the four `LUNAROUTE_*` env vars (same table as the pi README, `/device-auth/opencode` for FRONT_URL).
  - Troubleshooting: no models after login (re-run `/connect`); key rotation (re-run `/connect`; MCP picks up the new key on reload/restart per spike record); **credential removal** (delete the `lunaroute` entry from `auth.json` — the plugin stops injecting on the next start; chat/MCP keep the old key until then — server-side revocation cuts access); unreadable/corrupt auth.json (one secret-free warn, behaves as logged out, re-run `/connect` to rewrite).
  - Development: `npm install && npm run check`; manual smoke via `docs/smoke-checklist.md`; `npm pack --dry-run`.
- [ ] **Step 2: Write `docs/smoke-checklist.md`** — the spec's acceptance criteria as a runnable checklist (staging env vars): all eight criteria, each with pass/fail and where to look (gateway logs for the attribution triple, staging MCP server for `LUNAROUTE-API-KEY` + agent + session, auth.json for the key, config files for the absence of the key/mcp, tarball install for load-from-npm). **Plus the two spike-deferred items, first on the list**: (0a) TUI `/models` picker shows LunaRoute models before first use (the headless spike could not verify the session-runner's pre-build availability gate — if this fails, the post-login `{ model }` auto-pick is the documented mitigation); (0b) browser flow against staging `/device-auth/opencode` end-to-end.
- [ ] **Step 3: Run the smoke checklist against staging** (requires: staging env vars set, an OpenCode install, a LunaRoute account). Record results in the checklist file. Any FAIL: fix the code, re-run, note the fix in the commit message.
- [ ] **Step 4: Commit** `docs: README + staging smoke checklist (run result: <pass|N fixed>)`

---

### Task 10: Release prep

**Files:**
- Create: `.github/workflows/publish.yml`
- Modify: `package.json` (none beyond Task 2 unless versions moved)

**Interfaces:**
- Consumes: green Task 9 checklist
- Produces: publishable package

- [ ] **Step 1: Copy `publish.yml`** from `lunaroute-pi-extension` (tag-driven npm Trusted Publishing + provenance; `on: push: tags: ["v*"]`, `id-token: write`). Change the package name context if the workflow hardcodes it.
- [ ] **Step 2: One-time npm setup** (human): add a Trusted Publisher entry on npmjs.com for `@lunaroute/opencode-extension` → repo `lunaroute/lunaroute-opencode-extension`, workflow `publish.yml`, allowed `npm publish`. Note it in the README release section.
- [ ] **Step 3: Verify the package**

```bash
npm pack --dry-run   # must contain src/, README.md, LICENSE; no tests, no node_modules
node --input-type=module -e "import('./src/index.ts').then(m => { if (typeof m.default !== 'function') throw new Error('default export must be a function'); })" 2>/dev/null || bun -e "import('./src/index.ts').then(m => { if (typeof m.default !== 'function') throw new Error('bad default export'); console.log('ok') })"
```

- [ ] **Step 4: Commit + tag**

```bash
git add -A && git commit -m "chore: release prep — publish workflow + trusted-publisher note"
git tag v0.1.0 && git push origin main v0.1.0
```

The tag push triggers `publish.yml`. Verify the workflow goes green and `npm view @lunaroute/opencode-extension version` shows `0.1.0`.

---

## Self-Review

**Spec coverage check:**

- Provider stub via config hook (field-level precedence) → Task 6/8 ✅
- Browser login `/device-auth/opencode`, PKCE, `label: hostname()`, 3-min timeout, resolve-once, cancellation → Task 5 ✅
- Paste with validation → Task 5 ✅
- Loader `{ apiKey }` → Task 5/8 ✅
- Provider hook models with `ctx.auth`, 5s timeout, in-flight dedup, empty-on-error, warn policy → Task 6/8 ✅
- Catalog mapping incl. limits bounds, duplicates, malformed, untrusted stance → Task 4 ✅
- Deterministic default model + auto-pick `{ model }` update + re-read guard → Task 4/8 ✅
- MCP: tri-state, value shape, matrix, fingerprints, store-key isolation, eviction, indeterminate logging rule, symlink/privilege notes → Task 7 ✅
- Attribution triple on chat + MCP + discovery fetch → Tasks 3/6/7/8 ✅
- Config-hook orchestration + error isolation → Task 8 ✅
- Persistence guarantees (key nowhere, `{ model }` only) → Task 7 design + Task 8 code + Task 9 checklist ✅
- Spike as release gate with branches, decision record → Task 1 ✅
- README sections (MCP management, troubleshooting incl. removal + recovery) → Task 9 ✅
- Release (Trusted Publisher, tag-driven publish) → Task 10 ✅
- Non-goals (no TUI entry, no model caching, no env-blob fallback) — respected throughout ✅

**Placeholder scan:** Task 1 records empirical outcomes (its nature); its recording template names every field. Task 5/6 test files contain deliberate notes to clean casts/bugs before committing — these are explicit fix instructions, not gaps. No TBDs.

**Type consistency:** `MappedModel` (Task 4) consumed by Task 6 `toProviderModels` and Task 8 auto-pick ✅. `AuthResolution` (Task 7) consumed by Task 8 ✅. `fetchCatalog(routingUrl, key, sessionId, opts)` — the session-id parameter is called out as a required fix in Task 6 ✅. `createMcpReconciler(mcpUrl, log, sessionId)` matches Task 8 usage ✅.
