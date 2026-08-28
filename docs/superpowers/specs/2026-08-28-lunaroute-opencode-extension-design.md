# LunaRoute OpenCode Extension — Design

Date: 2026-08-28
Status: Approved direction (brainstorm), pending spec review
Kata: (to be created at implementation)

## Goal

Give [OpenCode](https://opencode.ai) the same LunaRoute experience the Pi
extension gives Pi: log in once via `/connect`, and every LunaRoute model shows
up correctly configured; every request carries LunaRoute attribution; the
hosted LunaRoute MCP server (image generation) is wired up automatically. No
hand-editing of `opencode.json`, no copying API keys around.

Feature parity with `lunaroute-pi-extension` v0.3.1:

| Pi extension behavior | OpenCode mechanism |
|---|---|
| `registerProvider` (openai-completions, baseUrl, `models: []`) | `config` hook injects `provider.lunaroute` stub (`npm: "@ai-sdk/openai-compatible"`, `options.baseURL`) |
| `/login lunaroute` → browser PKCE or paste | `auth` hook (`provider: "lunaroute"`): OAuth `method: "auto"` (browser) + `type: "api"` (paste, validated) |
| `refreshModels` catalog sync from `GET /v1/models` | `provider` hook `models()` (OpenCode ≥ 1.14.49) — receives `ctx.auth`, fetches catalog on model list |
| Attribution headers on every request | `chat.headers` hook (chat), MCP config headers (MCP), explicit headers on our own catalog fetches |
| pi-mcp-adapter runtime registration | Native remote MCP: `config` hook injects `mcp.lunaroute` (`type: "remote"`, `oauth: false`) — **no adapter dependency** |
| First-login auto-pick first model | Post-login best-effort `config.update` of `model` when unset |
| First-run hint | `client.app.log` info line when no key stored (TUI toast = follow-up) |

## Non-Goals (v1)

- TUI plugin entry (toasts, slash commands) — auth-hook prompts + log line cover v1 UX.
- Host OpenCode version in the `lunaroute-agent` header — the plugin API does
  not expose it; send bare `opencode` (backend classifies harness_code
  `opencode`, no version). Upgrade when the API grows one.
- Gateway `client_compat.opencode` metadata — reasoning models get standard
  `variants: {low, medium, high}` (reasoningEffort), same as the omniroute
  plugin convention.
- Model caching/TTL — fetch on provider-list (the gateway is fast; Pi has no
  cache either).
- Config-hook eager model fetch for OpenCode ≤ 1.14.48 — we set an engines
  floor instead (see Version floor).

## Architecture

TypeScript package `@lunaroute/opencode-extension`, raw TS in `src/` (OpenCode
runs on Bun; no build step — same approach as the Pi extension shipping
`src`). Installed via `"plugin": ["@lunaroute/opencode-extension"]` in
`opencode.json` (OpenCode npm-installs it at startup). Default export: the
`Plugin` function (reference implementations: `opencode-anthropic-auth`,
`opencode-omniroute-auth`).

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

Same env overrides as Pi:

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

### Auth hook (login.ts)

`auth: { provider: "lunaroute", methods: [...], loader }`:

- **Browser (OAuth, `method: "auto"`)** — port of Pi's `loginWithBrowser`:
  hex-sha256 PKCE (verifier/challenge), 16-byte state, loopback HTTP server on
  `127.0.0.1:0` listening for `/callback?code=&state=`, 3-minute timeout.
  `authorize()` returns `{ url, instructions, method: "auto", callback }`;
  callback verifies state, exchanges the code via
  `POST ${LUNAROUTE_API_URL}/v1/auth/exchange` with
  `{ code, verifier, label: hostname() }` (stored as
  `lunaroute-opencode <hostname>`), returns `{ type: "success", key: full_key }`.
- **Paste (`type: "api"`)** — text prompt `lr_...` with prefix validation;
  `authorize()` validates the key against `GET ${routingUrl}/models` (Bearer)
  before returning success/failed.
- **`loader`** — resolves the stored credential (api `key` or oauth `access`)
  and returns `{ apiKey: key }`, which OpenCode merges into the provider's
  options — this is how the custom provider authenticates chat requests
  (pattern proven by `opencode-anthropic-auth`). No key → return `{}` silently.

### Provider + models (models.ts)

- **`config` hook** — always injects the provider stub:
  `{ name: "LunaRoute", npm: "@ai-sdk/openai-compatible", options: { baseURL: routingUrl } }`,
  preserving any user-provided fields (`...existing`). Never sets `models` —
  the provider hook owns them.
- **`provider` hook** (`{ id: "lunaroute", models }`) — with `ctx.auth`:
  resolve key → no key: `{}` (logged out, silent); key:
  `GET ${routingUrl}/models` (Bearer + attribution headers, 5s timeout) →
  map catalog to `Record<string, ModelV2>`; fetch failure → `{}` (models
  vanish rather than go stale; next list open retries).

Catalog mapping (`GatewayModelObject` → OpenCode model):

- `id`, `name: display_name ?? id`
- `reasoning: capabilities.reasoning === true`; reasoning models get
  `variants: { low/medium/high: { reasoningEffort } }`
- `tool_call`: `capabilities.tools !== false` (default true)
- `attachment`/`modalities.input`: `["text", "image"]` when
  `capabilities.vision`, else `["text"]`
- `limit.context: context_window`, `limit.output: max_output_tokens`
  (missing → 0 = unknown)
- `cost`: zeros (gateway carries no pricing, same as Pi)
- `api: { id, url: routingUrl, npm: "@ai-sdk/openai-compatible" }`
- `status: "active"`

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

only when a key is stored. Key resolution at config time (auth resolution is
unreliable inside the hook — documented community pattern):
`OPENCODE_AUTH_CONTENT` env blob first (OpenCode injects it into
subprocesses), then `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json`,
entry `lunaroute` → api `key` / oauth `access`. No key → no injection, silent.

### Attribution (index.ts)

- `chat.headers` hook: when `input.provider.info.id === "lunaroute"`, set
  `lunaroute-agent: opencode`, `x-lunaroute-session: <uuid>`,
  `lunaroute-session-id: <uuid>` (one UUID per plugin instance; matches Pi's
  per-session id and the backend's `session_attribution` extraction).
- MCP headers carry the same triple (parity with Pi's `buildMcpDefinition`).

### Post-login best-effort refresh

After either login method succeeds (closure over the plugin `client`):

1. Read current config via `client.config.get()`.
2. Inject `mcp.lunaroute` (needs the fresh key).
3. If `config.model` is unset, set it to `lunaroute/<first-catalog-model>`
   (first-login auto-pick; never overrides an existing choice).
4. `client.config.update({ config })` (read-modify-write; community-proven
   pattern from `opencode-dynamic-custom-providers`' `/reload-models`).

Every step is wrapped: failures log via `client.app.log` and fall back to
"restart picks it up" (the config hook re-injects MCP at startup; the provider
hook re-serves models on the next `/models` open). Model availability itself
does not depend on this — the provider hook serves models whenever OpenCode
asks for them.

## Data flows

- **Startup**: config hook (provider stub + MCP if key) → provider registry
  build → auth `loader` merges `apiKey` into options.
- **`/connect lunaroute` → browser**: authorize() starts loopback + opens
  `/device-auth/opencode?port&state&challenge` → user approves →
  `127.0.0.1:port/callback?code&state` → exchange → key stored by OpenCode in
  auth.json → post-login refresh (MCP + optional default model).
- **`/models` open**: provider hook `models()` fetches catalog with stored key.
- **Chat request**: loader-injected `apiKey` authenticates; `chat.headers` adds
  attribution; gateway sees `harness_code: "opencode"`, session id, and key
  `source: "opencode"`.

## Error handling

- Loopback/state/timeout/exchange failures throw inside `callback()` →
  OpenCode shows the auth failure; nothing partial is stored.
- Paste validation failure → `{ type: "failed" }` (OpenCode re-prompts).
- Catalog fetch failure → empty model map (silent, retried next list).
- MCP injection failure → logged, retried at next startup.
- Config hook must never throw (breaks OpenCode startup): every external
  action inside it is caught.

## Testing

Vitest unit tests, one file per module, mirroring the Pi extension's suite:

- `lunaroute.test.ts` — PKCE (hex sha256), device-auth URL construction
  (incl. `/device-auth/opencode` path), callback parsing, catalog mapping
  table (reasoning/vision/limits/variants/defaults), attribution headers,
  session-id fallback, env resolvers.
- `login.test.ts` — loopback round-trip, state mismatch, timeout, exchange
  happy/error paths, paste-method validation (mocked fetch).
- `models.test.ts` — provider hook (no key → `{}`, key → mapped models, fetch
  error → `{}`), config-hook stub injection (preserves user overrides), MCP
  injection with/without key, auth.json reading (tmp dir, XDG override,
  `OPENCODE_AUTH_CONTENT` precedence).
- `index.test.ts` — plugin returns the expected hook set; `chat.headers` only
  mutates when provider is `lunaroute`.
- Manual smoke (README dev section, against staging env vars): `/connect`
  browser + paste, `/models` shows LunaRoute models, chat request verified on
  the gateway (attribution + `source: opencode`), MCP tool listed and callable,
  restart persistence, logged-out silence.

## Version floor

The `provider` hook (with `ctx.auth`) shipped in OpenCode ~1.14.49 (per
`opencode-omniroute-auth`'s compatibility comment); `chat.headers`, auth
hooks, and `PluginModule` are present in `@opencode-ai/plugin` 1.17.20 (current
npm). At implementation: verify the earliest release containing all used hooks
from the plugin package history and set `engines.opencode` + peer dependency
floor accordingly. Core dynamic model discovery (anomalyco/opencode PR #42660)
is unmerged and not required — our provider hook + gateway catalog metadata is
strictly richer than its ID-only discovery.

## Repo bootstrap (implementation plan scope)

- `package.json`: `@lunaroute/opencode-extension`, `type: module`,
  `files: ["src", "README.md", "LICENSE"]`, `peerDependencies:
  {"@opencode-ai/plugin": "^1.17.20"}`, `engines.opencode`, scripts
  `typecheck`/`test`/`check` (mirror the Pi repo).
- CI + release: copy `check.yml` and the tag-driven Trusted Publishing
  `publish.yml` from `lunaroute-pi-extension` (requires a one-time npm
  Trusted Publisher entry for the new package name).
- `kata init` for the repo; `.gitignore` including `node_modules/`.
