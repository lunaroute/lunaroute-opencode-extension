# LunaRoute OpenCode Extension — Design

Date: 2026-08-28 (rev 2 — after roborev design review)
Status: revised per design review findings
Kata: (created at implementation)

## Goal

Give [OpenCode](https://opencode.ai) the same LunaRoute experience the Pi
extension gives Pi: log in once via OpenCode's **`/connect`** command, and
every LunaRoute model shows up correctly configured; every request carries
LunaRoute attribution; the hosted LunaRoute MCP server (image generation) is
wired up automatically. No hand-editing of `opencode.json`, no copying API
keys around.

Feature parity with `lunaroute-pi-extension` v0.3.1:

| Pi side | OpenCode side |
|---|---|
| `registerProvider` (openai-completions, baseUrl, `models: []`) | `config` hook injects `provider.lunaroute` stub (`npm: "@ai-sdk/openai-compatible"`, `options.baseURL`) |
| Pi command `/login lunaroute` → browser PKCE or paste | OpenCode command `/connect` → pick **LunaRoute**: browser OAuth (`method: "auto"`) or paste (`type: "api"`, validated) |
| `refreshModels` catalog sync from `GET /v1/models` | `provider` hook `models()` (OpenCode ≥ 1.14.49) — receives `ctx.auth`, fetches catalog on model list |
| Attribution headers on every request | `chat.headers` hook (chat), MCP config headers (MCP), explicit headers on our own catalog fetches |
| pi-mcp-adapter runtime registration | Native remote MCP: `config` hook injects `mcp.lunaroute` (`type: "remote"`, `oauth: false`) — **no adapter dependency** |
| First-login auto-pick first model | Post-login best-effort `config.update` of `model` when unset |
| First-run hint | `client.app.log` info line when no key stored (TUI toast = follow-up) |
| Catalog persisted to Pi's ModelsStore, restored offline | **Not ported** (see Availability policy) |

## Non-Goals (v1)

- TUI plugin entry (toasts, slash commands) — auth-hook prompts + log line cover v1 UX.
- Host OpenCode version in the `lunaroute-agent` header — the plugin API does
  not expose it; send bare `opencode` (backend classifies harness_code
  `opencode`, no version). Upgrade when the API grows one.
- Gateway `client_compat.opencode` metadata — reasoning models get standard
  `variants: {low, medium, high}` (reasoningEffort), same as the omniroute
  plugin convention.
- Model caching/TTL/persistence — fetch on provider-list (see Availability policy).
- Automated OpenCode-in-CI integration test — manual smoke checklist against
  staging is the v1 gate (follow-up if it proves flaky).
- Config-hook eager model fetch for OpenCode ≤ 1.14.48 — engines floor instead.

## Architecture

TypeScript package `@lunaroute/opencode-extension`, raw TS in `src/` (OpenCode
runs on Bun, which executes TS natively; no build step — same approach as the
Pi extension shipping `src`). Installed via
`"plugin": ["@lunaroute/opencode-extension"]` in `opencode.json` (OpenCode
npm-installs it at startup). Default export: the `Plugin` function (reference
implementations: `opencode-anthropic-auth`, `opencode-omniroute-auth`).

Module layout mirrors the Pi extension:

```
src/
  lunaroute.ts   # pure helpers: constants, env resolvers, PKCE, attribution, catalog mapping
  login.ts       # auth hook: browser OAuth (PKCE loopback) + paste (validated)
  models.ts      # provider hook + catalog fetch + mapping to OpenCode model shape
  mcp.ts         # MCP config injection (native remote MCP)
  index.ts       # plugin entry: wires all hooks
tests/           # vitest, one file per module (mirrors pi-extension suite)
```

### Constants & env (lunaroute.ts)

| Variable | Default |
|---|---|
| `LUNAROUTE_ROUTING_URL` | `https://gw.lunaroute.com/v1` |
| `LUNAROUTE_API_URL` | `https://api.lunaroute.com` |
| `LUNAROUTE_FRONT_URL` | `https://app.lunaroute.com` |
| `LUNAROUTE_MCP_URL` | `https://mcp.lunaroute.com/mcp` |

Provider id: `lunaroute`. Browser auth URL:
`${LUNAROUTE_FRONT_URL}/device-auth/opencode?port=&state=&challenge=` — the
unified device-auth route shipped in lunaroute-saas #663 (registry source
`opencode`, key label prefix `lunaroute-opencode`).

**Base URL precedence** (explicit user intent beats environment defaults):
`provider.lunaroute.options.baseURL` set by the user in `opencode.json` →
`LUNAROUTE_ROUTING_URL` env → production default. The catalog fetch and
provider stub use the same resolved value.

### Auth hook (login.ts)

`auth: { provider: "lunaroute", methods: [...], loader }`:

- **Browser (OAuth, `method: "auto"`)** — port of Pi's `loginWithBrowser`:
  hex-sha256 PKCE (verifier/challenge), 16-byte state, loopback HTTP server on
  `127.0.0.1:0` listening for `/callback?code=&state=`, 3-minute timeout.
  `authorize()` returns `{ url, instructions, method: "auto", callback }`;
  callback verifies state, exchanges the code via
  `POST ${LUNAROUTE_API_URL}/v1/auth/exchange` with
  `{ code, verifier, label: hostname() }` (stored as
  `lunaroute-opencode <hostname>`; hostname is visible only inside the user's
  own org dashboard — same as Pi), returns `{ type: "success", key: full_key }`.
  **Loopback lifecycle**: server closed in `finally`; timeout timer cleared;
  the callback promise resolves once — repeated browser callbacks after the
  first are ignored. Cancellation (user closes browser / gives up) surfaces as
  the 3-minute timeout inside `callback()` → OpenCode shows auth failed;
  nothing partial is stored.
- **Paste (`type: "api"`)** — text prompt `lr_...` with prefix validation;
  `authorize()` validates the key against `GET ${routingUrl}/models` (Bearer)
  before returning success/failed.
- **`loader`** — resolves the stored credential (api `key` or oauth `access`)
  and returns `{ apiKey: key }`, which OpenCode merges into the provider's
  options — this is how the custom provider authenticates chat requests
  (pattern proven by `opencode-anthropic-auth`). No key → return `{}` silently.

### Provider + models (models.ts)

- **`config` hook** — injects the provider stub **only where the user hasn't
  set a value** (field-level precedence, no deep merge):
  `name: existing?.name ?? "LunaRoute"`,
  `npm: existing?.npm ?? "@ai-sdk/openai-compatible"`,
  `options: { ...existing?.options, baseURL: existing?.options?.baseURL ?? routingUrl }`.
  Never sets `models` — the provider hook owns them.
- **`provider` hook** (`{ id: "lunaroute", models }`) — with `ctx.auth`:
  resolve key → no key: `{}` (logged out, silent); key:
  `GET ${routingUrl}/models` (Bearer + attribution headers, 5s timeout, single
  attempt — no retry policy; the next `/models` open retries naturally) →
  map catalog to `Record<string, ModelV2>`. The hook may be called
  concurrently by OpenCode; the fetch is stateless, so this is safe.

**Catalog mapping** (`GatewayModelObject` → OpenCode model):

- `id`, `name: display_name ?? id`
- `reasoning: capabilities.reasoning === true`; reasoning models get
  `variants: { low/medium/high: { reasoningEffort } }`
- `tool_call`: `capabilities.tools !== false` (default true)
- `attachment`/`modalities.input`: `["text", "image"]` when
  `capabilities.vision`, else `["text"]`
- `limit.context: context_window ?? 128000`,
  `limit.output: max_output_tokens ?? 4096` — **conservative defaults when
  the catalog omits them, never 0** (OpenCode's downstream token math does not
  document a 0-means-unknown convention; 128k/4096 matches the community
  default in `opencode-dynamic-custom-providers` and models.dev fallbacks)
- `cost`: zeros (gateway carries no pricing, same as Pi)
- `api: { id, url: routingUrl, npm: "@ai-sdk/openai-compatible" }`
- `status: "active"`

**Malformed catalog handling**: entries without an `id`, duplicate ids
(first wins, rest skipped + logged), or non-object entries are skipped and
logged via `client.app.log` (warn) — never throw. An empty or fully-malformed
catalog yields an empty model map (silent).

### MCP (mcp.ts)

`config` hook (and post-login update) injects:

```json
{
  "type": "remote",
  "url": "${LUNAROUTE_MCP_URL}",
  "headers": { "LUNAROUTE-API-KEY": "<key>", ...attribution },
  "oauth": false,
  "enabled": true
}
```

only when a key is stored, **and only when `cfg.mcp.lunaroute` does not
already exist** (a user-defined `mcp.lunaroute` entry is respected
untouched). Key resolution at config time (auth resolution is unreliable
inside the hook — documented community pattern): `OPENCODE_AUTH_CONTENT` env
blob first (OpenCode injects it into subprocesses), then
`${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json`, entry `lunaroute` →
api `key` / oauth `access`. No key → no injection, silent.

### Attribution (index.ts)

- One session UUID per plugin instance (per OpenCode process), generated once
  at plugin init; the fallback path (used only when `randomUUID` throws in a
  constrained runtime) derives `lunaroute-opencode-<ts>-<rand>`. The same
  instance id is used by chat headers and MCP headers, so they stay consistent
  within a session and both regenerate on restart.
- `chat.headers` hook: when `input.provider.info.id === "lunaroute"`, set
  `lunaroute-agent: opencode`, `x-lunaroute-session: <uuid>`,
  `lunaroute-session-id: <uuid>` (matches Pi's triple and the backend's
  `session_attribution` extraction).

### Post-login best-effort refresh

After either login method succeeds (closure over the plugin `client`):

1. Read current config via `client.config.get()`.
2. Inject `mcp.lunaroute` if absent (needs the fresh key).
3. If `config.model` is unset, fetch the catalog with the new key and set
   `model: "lunaroute/<first-catalog-model>"` (first-login auto-pick; never
   overrides an existing choice).
4. `client.config.update({ config })` (read-modify-write).

Every step is caught and logged; failures fall back to restart semantics (the
config hook re-injects MCP at startup; the provider hook re-serves models on
the next `/models` open). Model availability itself does not depend on this.

## Persistence & secret handling

- **The only persistent credential is OpenCode's own auth store**
  (`~/.local/share/opencode/auth.json`), written by OpenCode when `/connect`
  succeeds. The plugin never writes keys anywhere else.
- **`config` hook mutations and `client.config.update` mutate the live,
  in-session config only** — they do not write `opencode.json`. Evidence:
  both community precedents (`opencode-dynamic-custom-providers`' `/reload-models`
  "updates the live config", `opencode-models-discovery` "enhanced configuration
  is used for the current session") rely on exactly this. The compatibility
  spike (below) re-verifies it directly: run a config update, then diff
  `opencode.json` — must be untouched.
- MCP headers carrying the key therefore exist only in memory, never in user
  files.
- **Key rotation**: re-running `/connect` replaces the auth-store entry; the
  post-login refresh re-injects MCP headers with the new key (or the next
  restart does). **Removal**: delete the `lunaroute` entry from auth.json —
  documented in the README troubleshooting section (OpenCode has no
  `/disconnect` command as of this writing; if one ships, use it).
- **Logs**: never log the key or `Authorization` header values; error paths
  stringify fetch failures with the URL and status only.

## Data flows

- **Startup**: config hook (provider stub + MCP if key) → provider registry
  build → auth `loader` merges `apiKey` into options.
- **`/connect` → browser**: authorize() starts loopback + opens
  `/device-auth/opencode?port&state&challenge` → user approves →
  `127.0.0.1:port/callback?code&state` → exchange → key stored by OpenCode in
  auth.json → post-login refresh (MCP + optional default model).
- **`/models` open**: provider hook `models()` fetches catalog with stored key.
- **Chat request**: loader-injected `apiKey` authenticates; `chat.headers` adds
  attribution; gateway sees `harness_code: "opencode"`, session id, and key
  `source: "opencode"`.

## Acceptance criteria

Manual smoke checklist against staging (README dev section), each item
pass/fail:

1. `/connect` browser flow completes; key lands in auth.json only; running it
   twice in a row (re-login) replaces the credential and MCP picks up the new
   key without a stale-header error.
2. `/models` shows LunaRoute models with correct names; selecting one and
   chatting works; gateway logs show the attribution triple.
3. Cancelling the browser (never approving) → auth fails after 3 minutes,
   nothing stored, no dangling listener (port is released).
4. Revoked key: `/models` shows no LunaRoute models (fetch 401 → empty), chat
   fails with the gateway's 401 surfaced by OpenCode — no crash, no empty
   model used silently.
5. Logged out entirely: no `mcp.lunaroute`, no LunaRoute models, one info log
   line, no errors.
6. Install from the **packed tarball** (`npm pack` output) into a real
   OpenCode, not just a repo checkout — proves the package loads from npm.
7. `opencode.json` is byte-identical after login + post-login refresh
   (persistence guarantee).
8. User pre-set `provider.lunaroute.options.baseURL` or a user-defined
   `mcp.lunaroute` survive a restart untouched.

## Availability policy (documented divergence from Pi)

The Pi extension persists its catalog to Pi's ModelsStore and restores it
offline. OpenCode's provider hook has no persistence slot for plugin-served
models, so v1 is stateless: a transient gateway failure yields an empty
LunaRoute model list until the next `/models` open retries. Adding a file
cache is a small follow-up if this hurts in practice (omniroute's TTL cache
is the pattern); it is deliberately out of v1.

## Version floor & compatibility spike (first implementation task)

The `provider` hook (with `ctx.auth`) shipped in OpenCode ~1.14.49 (per
`opencode-omniroute-auth`'s compatibility comment); `chat.headers`, auth
hooks, and `PluginModule` are present in `@opencode-ai/plugin` 1.17.20
(current npm). Before any other work:

1. Resolve the earliest OpenCode release containing every hook we use
   (provider, auth, config, chat.headers) from the plugin package history.
2. Verify `client.config.update` is live-only (acceptance criterion 7).
3. Verify a raw-TS npm package with default-export Plugin loads from a
   packed tarball (acceptance criterion 6).

Results are recorded here (`engines.opencode`, peer dependency floor) before
the scaffold lands. Core dynamic model discovery
(anomalyco/opencode PR #42660) is unmerged and not required — our provider
hook + gateway catalog metadata is strictly richer than its ID-only discovery.

## Implementation staging

Ordered stages (detailed task breakdown goes in the implementation plan
document, per writing-plans):

1. Compatibility spike (above) — version lock + the two verifications.
2. Repo scaffold: `package.json` (see below), `tsconfig.json`, vitest config,
   `.gitignore` (incl. `node_modules/`), `kata init`, CI workflows.
3. `src/lunaroute.ts` pure helpers + `tests/lunaroute.test.ts`.
4. `src/login.ts` auth flow + `tests/login.test.ts`.
5. `src/models.ts` provider/catalog + `tests/models.test.ts`.
6. `src/mcp.ts` MCP injection + `tests/mcp.test.ts`.
7. `src/index.ts` hook wiring + `tests/index.test.ts`.
8. README (install, connect, env vars, troubleshooting incl. credential
   removal) + manual smoke checklist run against staging.
9. Release: npm Trusted Publisher entry for `@lunaroute/opencode-extension`,
   tag-driven publish (copy `publish.yml` from `lunaroute-pi-extension`).

## Repo bootstrap details

- `package.json`: `@lunaroute/opencode-extension`, `type: module`,
  **`main`/`exports` → `./src/index.ts`** (default export: the `Plugin`
  function; keep root exports function-only — the plugin loader reads them),
  `files: ["src", "README.md", "LICENSE"]`,
  `peerDependencies: {"@opencode-ai/plugin": "^1.17.20"}` (adjusted to the
  spike result), `engines.opencode` (spike result), scripts
  `typecheck`/`test`/`check`, `npm pack --dry-run` as a release-blocking
  check.
- CI: copy `check.yml` (typecheck + test) and the tag-driven Trusted
  Publishing `publish.yml` from `lunaroute-pi-extension`.
- README covers install, `/connect` flow, env vars, and upgrade notes.
