# LunaRoute OpenCode Extension — Design

Date: 2026-08-28 (rev 9 — after eighth review; complete injection lifecycle matrix)
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
  concurrently by OpenCode; a single in-flight fetch promise is shared
  (memoized until it settles) so concurrent calls don't duplicate requests.

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

**Malformed catalog handling** — per-field coercion/validation rules:

- entry not an object, or `id` not a non-empty string → skip + log warn
- duplicate `id` → first wins, later ones skipped + logged
- `display_name` not a string → fall back to `id`
- limits: `Number.isSafeInteger(x) && x > 0` and within plausible bounds
  (`context ≤ 100_000_000`, `output ≤ 10_000_000` — ≥50× any real model) →
  use as-is; anything else (negative, fractional, NaN, strings, beyond
  safe-integer or the plausible bound) → conservative default (128000 / 4096).
  Catalog values are treated as **untrusted remote input** even though the
  gateway is ours — validation never trusts the source.
- capabilities: only `=== true` counts as true (non-boolean ⇒ false)

Skipped entries emit exactly **one warn per skipped entry** (id + reason,
never the entry payload); when every entry in an authenticated catalog was
skipped, one additional summary warn is emitted ("N invalid entries, all
skipped"). "Silent" refers only to user-facing UX (no crash, no error
toast). The logged-out case emits the single info line "Run /connect to
start using LunaRoute" and nothing else.

### MCP (mcp.ts)

**Injection is config-hook-only** — never via `client.config.update`.
Verified from OpenCode source: the update path (`POST /config` →
`Config.Service.update`) **deep-merges and persists to
`<instance dir>/config.json`** — sending MCP headers through it would write
the `lr_` key to a plaintext config file. The config hook, by contrast,
mutates the in-memory live config for the session and is never written back
by OpenCode. So MCP is injected exactly when a valid key exists at
config-hook time: at startup, refreshed on instance reload, absent when no
key exists.

**Ownership rule (in-process provenance).** The plugin keeps, per config
object (a `WeakMap` keyed by the config object itself — scoped to that
config's lifecycle, garbage-collected with it, immune to cross-instance
contamination), the last entry it injected. `mcp.lunaroute` is user-owned
iff it exists at `config`-hook entry **and does not deep-match that
process-and-config's last injected entry**. Since the plugin never persists
an MCP entry, a pre-existing entry can only be user-authored or our own
prior injection surviving a same-process hook re-run — the deep match
distinguishes exactly those two, and correctly handles both reload
semantics (fresh config from files: entry absent; mutated in-memory
config: our entry matches). A user-edited entry (any divergence) →
user-owned, never touched again this process (log one info line when a
key exists but the entry is user-owned). On a fresh process there is no
prior injection, so any pre-existing entry is user-authored by
construction.

**Injection lifecycle — the complete decision matrix** (key = validated
credential from auth.json; ours = deep-matches our last injection for this
config):

| key | entry at hook entry | action |
|---|---|---|
| present | absent | inject |
| present | ours | replace with current key |
| present | user-owned | leave untouched (one info log) |
| absent | absent | nothing |
| absent | ours | **remove our entry** (stale managed credential cleanup) |
| absent | user-owned | leave untouched |

**Key resolution (single source of truth).** Auth resolution is unreliable
inside the hook (documented community pattern), so the plugin resolves the
key itself: read **auth.json only** — resolved via OpenCode's own data-dir
logic for the platform (**release gate**: the spike must record either the
supported SDK/source-derived resolution for Linux + macOS, or v1 narrows
its supported platforms accordingly) — entry `lunaroute` → api `key` /
oauth `access`. That file is what `/connect` writes, so it is always
freshest after a login or rotation. **No `OPENCODE_AUTH_CONTENT` fallback**:
the env blob may be a stale process-start snapshot, and a missing or
unparseable auth.json means *logged out*. **File policy**: symlinks are
followed (dotfile managers legitimately symlink auth.json; OpenCode reads
it plainly, so do we); the parsed record must be an object with a string
`key`/`access` for `lunaroute`, else no credential; exactly one read, one
warn on failure, **no retry** (a transient race with OpenCode's write
resolves on the next hook run). Spike item (h) proves the chain
end-to-end: re-login → auth.json updated → next config-hook run injects
the new key.

**Removal semantics (stated once, consistently):** per the matrix above —
a key removed from auth.json takes effect at the **next config-hook run**
(instance reload or restart), where our own entry is actively removed; a
user-owned entry survives regardless. Until that run, the in-memory MCP
header **and the loader-injected chat `apiKey`** (also a load-time
snapshot, not per-request) both keep the old key; server-side revocation
is what actually cuts access. No mid-session eager removal — the plugin
has no config write path for MCP outside the hook.

The hook injects, only when a validated key is stored **and** `mcp.lunaroute`
is not user-owned:

```json
{
  "type": "remote",
  "url": "${LUNAROUTE_MCP_URL}",
  "headers": { "LUNAROUTE-API-KEY": "<key>", ...attribution },
  "oauth": false,
  "enabled": true
}
```

**Consequence, documented**: after a first login or key rotation, MCP tools
appear without a manual restart only if OpenCode re-runs the config hook on
instance reload (`update` marks the instance for disposal — reload behavior
verified in the spike). If the hook does not re-run, a restart is required
for MCP. Pi achieves live registration via pi-mcp-adapter's in-process
event; OpenCode's plugin API has no equivalent — a platform gap. A future
OAuth flow on the hosted MCP server would remove the key from config
entirely and is the recommended long-term fix (follow-up, backend side).

### Config-hook orchestration (index.ts)

OpenCode exposes **one** `config` hook per plugin. `index.ts` owns it and
composes the two contributors in a fixed order, each as a pure function over
the config object, each individually try/caught (a failure in one must not
prevent the other):

1. `injectProviderStub(cfg)` (from `models.ts`) — provider defaults, never
   overwriting user-set fields.
2. `injectMcp(cfg)` (from `mcp.ts`) — plugin-managed MCP entry only
   (ownership decided inside, from hook-entry state).

There is no post-login config write of provider or MCP state — the only
post-login mutation is the `model` auto-pick (see Post-login refresh).

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

After either login method succeeds (closure over the plugin `client`), the
**only** mutation is the default-model auto-pick:

1. Read current config via `client.config.get()`.
2. If `config.model` is unset, fetch the catalog with the new key, **re-read
   `model` immediately before writing, and skip the auto-pick if it has
   become set** (a user picking a model in `/models` during login must not
   be overwritten); then call `client.config.update({ config: { model:
   "lunaroute/<first-mapped-model>" } })` — payload contains **exactly the
   `model` key, never the full config, never `mcp`** (update deep-merges
   and persists to the instance `config.json` — persisting a default model
   is desirable and matches Pi's `setModel` save; persisting anything
   secret is forbidden). Deterministic rule: lexicographically smallest
   `id` among **successfully mapped** entries; empty mapped list → skip.
   The residual read→write window (milliseconds) is accepted and documented:
   a selection made inside it is overwritten once; the user re-selects. No
   conflict-aware primitive exists in the plugin API.
3. MCP is NOT written here (see MCP section). If OpenCode re-runs the
   config hook on the instance reload that `update` triggers, MCP refreshes
   with the fresh key automatically — verified in the spike; otherwise a
   restart is required (documented behavior).

Every step is caught and logged. Model availability itself never depends
on this — the provider hook serves models on the next `/models` open.

## Persistence & secret handling

- **The only persistent credential is OpenCode's own auth store**
  (`~/.local/share/opencode/auth.json`), written by OpenCode when `/connect`
  succeeds. The plugin never writes keys anywhere else.
- **Config hook mutations are in-memory only** — the hook mutates the live
  config object for the session; OpenCode writes config files only on
  explicit `update` calls, and the plugin never sends MCP/key data through
  `update`. **`client.config.update` is NOT memory-only** (corrected from
  community docs by reading the source): `POST /config` →
  `Config.Service.update` deep-merges the payload and **persists to
  `<instance dir>/config.json`**, then marks the instance for disposal
  (reload). The plugin's only `update` payload is `{ model }` — non-secret,
  persisted deliberately (default-model preference, Pi `setModel` parity).
  The spike re-verifies both properties on the pinned version.
- MCP headers carrying the key exist only in the in-memory live config,
  never in any file.
- **Key rotation**: re-running `/connect` replaces the auth-store entry; MCP
  picks up the new key on instance reload (if the config hook re-runs —
  spike-verified) or restart. **Removal**: delete the `lunaroute` entry from
  auth.json — documented in the README troubleshooting section (OpenCode has
  no `/disconnect` command as of this writing; if one ships, use it).
  **Mid-session removal caveat**: there is no auth-change event in the plugin
  API, so a live session's plugin-managed MCP entry retains the removed key
  until the next hook/loader run (reload/restart) — both the in-memory MCP
  header and the loader-injected chat `apiKey` are load-time snapshots;
  server-side revocation is what actually cuts access. Documented limitation,
  verified in
  stage 8.
- **Logs**: never log the key or `Authorization` header values; error paths
  stringify fetch failures with the URL and status only — including warns, caught exceptions, and debug logs; warn lines for
  skipped catalog entries include counts and ids, never entry payloads.
- **Credential/header value validation**: before a stored key is placed into
  MCP headers it must be a non-empty printable-ASCII string (no control
  characters) of sane length (≤ 512); a malformed auth-store entry is treated
  as no key (skip injection, one warn log).
- **Update concurrency**: the only update is a single-key `{ model }`
  deep-merge; a concurrent change to `model` by the user is last-writer-wins
  on one non-secret preference and self-heals via `/models`. No config
  locking exists in the plugin API; no retry loop by design.

## Data flows

- **Startup**: config hook (provider stub + MCP if key) → provider registry
  build → auth `loader` merges `apiKey` into options.
- **`/connect` → browser**: authorize() starts loopback + opens
  `/device-auth/opencode?port&state&challenge` → user approves →
  `127.0.0.1:port/callback?code&state` → exchange → key stored by OpenCode in
  auth.json → optional default-model pick (`{ model }` update) → MCP on
  instance reload (if the spike confirms the config hook re-runs) or
  restart.
- **`/models` open**: provider hook `models()` fetches catalog with stored key.
- **Chat request**: loader-injected `apiKey` authenticates; `chat.headers` adds
  attribution; gateway sees `harness_code: "opencode"`, session id, and key
  `source: "opencode"`.

## Acceptance criteria

### Unit tests (vitest, one file per module — mirrors the pi-extension suite)

- `lunaroute.test.ts` — PKCE (hex sha256), device-auth URL construction
  (incl. `/device-auth/opencode` path), callback parsing, catalog mapping
  table (reasoning/vision/variants/limits/defaults), attribution headers,
  session-id fallback, env resolvers, base-URL precedence.
- `login.test.ts` — loopback round-trip, state mismatch, timeout, exchange
  happy/error paths, paste-method validation (mocked fetch), double-callback
  ignored.
- `models.test.ts` — provider hook (no key → `{}`, key → mapped models,
  fetch error → `{}`), config-hook stub injection (preserves user
  overrides), catalog validation table (fractional / beyond-bound /
  negative limits fall back; large-but-plausible accepted; non-string ids
  and duplicates skipped; fully-invalid catalog → per-entry warns plus one
  summary line),
  deterministic default-model rule (lexicographic first; empty → no
  auto-pick), in-flight fetch dedup.
- `mcp.test.ts` — the full injection lifecycle matrix (six cells): key+absent
  → inject; key+ours → replace with current key; key+user-owned → untouched
  (info log); no-key+absent → nothing; **no-key+ours → entry removed**;
  no-key+user-owned → untouched. Auth-file policy (missing file → no
  credential; corrupt/unexpected shape → no credential + one warn; symlink
  followed; single read, no retry). In-process provenance is per-config
  (WeakMap) — two config objects don't cross-contaminate. The post-login
  update payload contains exactly `{ model }` (never mcp, never keys);
  the auto-pick re-read guard (model set between steps → skip). the post-login update payload contains
  exactly `{ model }` (never mcp, never keys); the auto-pick re-read guard
  (model set between steps → skip).
- `index.test.ts` — config-hook orchestrator order + per-contributor error
  isolation; `chat.headers` only mutates when the provider is `lunaroute`.

### Manual smoke checklist (against staging, README dev section)

1. `/connect` browser flow completes; key lands in auth.json only; running it
   twice in a row (re-login) replaces the credential, and after a restart (or
   instance reload, per spike result) **MCP requests carry the new key and
   the current session attribution** (verified on the staging MCP server:
   `LUNAROUTE-API-KEY` + `lunaroute-agent` + session id — checked after
   first login and again after re-login).
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
7. After login + post-login refresh: no config file contains the key or an
   `mcp.lunaroute` entry written by the plugin; the instance `config.json`
   may gain only the `model` field (auto-pick); global `opencode.json`
   untouched.
8. User pre-set `provider.lunaroute.options.baseURL` or a user-defined
   `mcp.lunaroute` survive a restart untouched — and a re-login while a
   user-defined `mcp.lunaroute` exists leaves it untouched (info log shown).

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
3. **Behavioral proof against the selected version**: build a **disposable
   minimal fixture package** in a scratch directory (not the repo scaffold —
   a hello-plugin exercising exactly the provider/auth/config/chat.headers
   hooks we depend on, packed with `npm pack`), plus a local fake gateway
   (plain HTTP server serving one `/models` entry). Load the fixture into a
   real OpenCode run and verify: (a) paste-auth validation against the fake
   gateway succeeds, (b) the provider hook serves the fake model, (c) a
   config-hook orchestrator contributes provider stub **and** MCP entry
   together, including the fresh-first-login injection path, (d) the mapped
   `ModelV2` is accepted and token budgeting behaves — fixture catalog
   includes a large-but-plausible limit (accepted), a fractional limit and a
   beyond-bound limit (both fall back to defaults), (e) `opencode.json`
   untouched after `config.update`, (f) the **browser flow contract,
   headless**: run `authorize()`, parse the returned loopback port + state
   from the URL, `curl` the `/callback?code=&state=` on the loopback server
   (simulating the browser redirect; `LUNAROUTE_API_URL` pointed at the fake
   exchange), assert the auth result resolves — plus a cancellation case
   (no callback → 3-minute timeout, listener released); (g) **config
   persistence semantics**: after the model auto-pick `update`, the
   instance `config.json` contains only the `model` addition (no key, no
   mcp), and a config-hook injection leaves all files untouched; (h)
   **instance reload**: after `update` (which marks the instance for
   disposal), does the config hook re-run with the fresh key (MCP refresh
   without restart)? Does it receive a **freshly reconstructed config or
   the mutated in-memory one** (both must work under the in-process
   provenance rule — begin from a plugin-injected entry and assert the
   rotated key lands)? And on that reload: does a **user-defined
   `mcp.lunaroute` survive untouched** while an absent entry gets the
   rotated key? (i) **chat-loader reload**: does the instance reload recreate
   the provider/loader (fresh chat `apiKey` from the new auth-store entry)
   or keep the load-time snapshot? Record the answer — the README's
   rotation instructions depend on it ("restart required" vs
   "automatic"). All spike outcomes are release gates; unresolved items
   narrow v1 scope rather than ship on assumptions.
   The fixture is throwaway; production code starts at stage 2.

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
7. `src/index.ts` hook wiring (config-hook orchestrator) + `tests/index.test.ts`.
8. **Secret lifecycle verification**: re-login replaces key; MCP headers
   refresh on reload **if spike item (h) confirmed the config hook re-runs
   — otherwise verify and document restart-required behavior**; auth-store
   entry removed mid-session → live MCP keeps stale key until next hook
   run (documented limitation + README note: remove the entry and restart,
   or re-login to refresh); restart with no key → no injection; no config
   file ever gains the key or an `mcp.lunaroute` entry.
9. README (install, connect, env vars, troubleshooting incl. credential
   removal) + manual smoke checklist run against staging.
10. Release: npm Trusted Publisher entry for `@lunaroute/opencode-extension`,
   tag-driven publish (copy `publish.yml` from `lunaroute-pi-extension`).

Follow-up milestone (post-v1): automated packed-tarball integration smoke in
CI — the version-sensitive boundary (package load + hook wiring) currently
relies on the manual staging gate.

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
