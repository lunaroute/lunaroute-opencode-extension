# LunaRoute OpenCode Extension — Design

Date: 2026-08-28 (rev 15 — after fourteenth review; bounded-guarantee stated, store-key canonicalization)
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
by OpenCode. So MCP is reconciled **exactly when the config hook runs** —
at startup always, and on instance reload only if the host re-runs the hook
(spike gate branch (a)/(b) below decides which; until decided, no claim of
reload-time refresh is made anywhere).

**Ownership rule (value-shape recognition — lifecycle-agnostic).** The
plugin recognizes its own entry **by value, not by tracked identity**: an
entry is **ours** iff `type === "remote"` && `url` equals the resolved MCP
URL && `oauth === false` && `enabled === true` && the set of header names
equals ours (`LUNAROUTE-API-KEY` + the attribution triple — compared
case-insensitively, per HTTP header semantics; if the entry contains
duplicate logical names, e.g. both `LUNAROUTE-API-KEY` and
`lunaroute-api-key`, the shape is malformed → user-owned, left untouched —
deterministic, no canonicalization). This works identically
whether a reload hands the hook a fresh config, a clone, or the same
mutated object — no per-object provenance state exists to go stale.
Anything else is **user-owned while its shape diverges** — restoring the
exact shape re-enters plugin management (stateless recognition has no
memory of past ownership). All header *values* in a managed entry are
plugin-managed and rewritten on refresh (the attribution triple as well as
the key).

**Exact-shape collisions (documented, deliberate).** A user who hand-writes
our exact shape gets a *refresh* — header values rewritten with the current
key and attribution (functionally the same server and credential scheme).
The **one unavoidable residual**: an entry that matches our shape *and*
carries a credential the plugin previously injected is indistinguishable
from the plugin's own entry — including a hand-authored copy — and is
treated as ours (refreshed when a key exists, removed on confirmed
logout). Structural matching cannot establish who placed an identical
value; this residual is accepted and asserted in tests, not promised away.
Opt-out: set `enabled: false` (the standard OpenCode way to keep an entry
but stop using it) or diverge the URL — the entry is then user-owned **as
long as its shape diverges**; restoring the managed shape re-enters
management (stateless recognition has no persistent opt-out). (An extra
header is *not* an opt-out: it would be forwarded to the MCP server.)

**Injection lifecycle — the complete decision matrix.** State is kept as
`Map<authStorePath, Set<fingerprint>>` — keyed by the **resolved auth-store
path** (not process-global: correct even if the host ever varies the data
dir, and isolated between test contexts), holding **SHA-256 fingerprints**
of credentials this process successfully wrote into managed entries (never
the raw secrets; bounded to the most recent 8 per store — older
fingerprints fall back to the unknown-credential path, which is
fail-safe). Added on every injection/refresh; never cleared by reads; dies
with the process (no cross-process persistence by design). The set covers
every config generation reconciled against that store, so an older config
still carrying a previously-injected credential is cleaned up too:

| resolution | entry at hook entry | action |
|---|---|---|
| valid key | absent | inject (adds fingerprint) |
| valid key | ours | replace all header values (adds fingerprint) |
| valid key | user-owned | leave untouched (one info log) |
| confirmed logged out | absent | nothing |
| confirmed logged out | ours, fingerprint ∈ set | **remove** |
| confirmed logged out | ours, other credential | leave untouched (one info log) |
| confirmed logged out | user-owned | leave untouched |
| **indeterminate** | managed-shape entry present | **retain everything** + one redacted warn |
| **indeterminate** | nothing to retain | silent no-op (the warn fires only when something was retained — a fresh install must not warn) |

**Key resolution (single source of truth, tri-state).** Auth resolution is
unreliable inside the hook (documented community pattern), so the plugin
resolves the key itself: read **auth.json only** — resolved via OpenCode's
own data-dir logic for the platform (**release gate**: the spike must
record either the supported SDK/source-derived resolution for Linux +
macOS, or v1 narrows its supported platforms accordingly) — entry
`lunaroute` → api `key` / oauth `access`. That file is what `/connect`
writes, so it is always freshest after a login or rotation. **No
`OPENCODE_AUTH_CONTENT` fallback** (the env blob may be a stale
process-start snapshot). **File policy**: symlinks are followed, with no
containment or permission requirements beyond readability (OpenCode reads
the file plainly; so do we — dotfile-manager symlinks are legitimate).
Exactly one read, one warn on failure, **no retry**. The resolution is
**tri-state**, because absence of evidence is not evidence of logout:

- **valid key** — file readable, `lunaroute` entry present, credential
  shape-valid → act (inject/refresh per matrix);
- **confirmed logged out** — file readable and the `lunaroute` entry is
  absent → removal path per matrix. (A *readable, well-formed store with
  the entry gone* is the only durable logout signal; a **missing file** is
  NOT — OpenCode may replace files non-atomically during writes, and
  deletion of the whole store is not the documented logout path — so a
  missing file is classified indeterminate whenever any managed state
  could exist, and nothing-to-do otherwise);
- **indeterminate** — file present but the `lunaroute` record is
  present-but-invalid (missing field; `null`, array, or primitive value;
  non-string/empty credential, control characters, oversize), file
  unparseable, unreadable, or **missing** — a missing file is NOT a durable
  logout signal (OpenCode may replace files non-atomically during writes,
  and deleting the whole store is not the documented logout path): the
  result is **indeterminate** — retain any managed-shape entry (one
  redacted warn, only when something was retained) and otherwise a silent
  no-op. The next hook run with a clean read reconciles.

Spike item (h) proves the chain end-to-end: re-login → auth.json updated →
next config-hook run injects the new key.

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
- **Logs**: never log the key or `Authorization` header values — including
  warns, caught exceptions, and debug logs — and never serialize the parsed
  auth record or the injected MCP object in diagnostics; error paths
  stringify fetch failures with the URL and status only; warn lines for
  skipped catalog entries include counts and ids, never entry payloads.
- **Credential/header value validation**: before a stored key is placed into
  MCP headers it must be a non-empty printable-ASCII string (no control
  characters) of sane length (≤ 512); a malformed auth-store entry is treated
  as no key (skip injection, one warn log). README troubleshooting includes
  recovery guidance for an unreadable/corrupt auth.json: the plugin logs one
  secret-free warn and behaves as logged out; re-running `/connect` rewrites
  the store and restores the session.
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
- `mcp.test.ts`, split into independently reviewable groups:
  - **auth resolver**: tri-state classification (valid /
    confirmed-logged-out / indeterminate) including record-shape boundaries
    (`null`, array, primitive, missing field, non-string/empty/
    control-char/oversize credential → present-but-invalid → indeterminate);
    missing file → indeterminate (retained-entry warn; silent no-op when
    nothing to retain); symlink followed; single read, no retry.
  - **ownership/reconciliation**: the full matrix (each row, in the
    current terminology — fingerprint set, tri-state resolution);
    value-shape recognition (fresh, cloned, mutated config objects
    classify identically; divergences — enabled toggled, different url,
    extra header, duplicate logical header names → user-owned; case
    variants of our header names normalize to ours); residual collision
    asserted (hand-authored exact shape with fingerprint ∈ set → removed
    on confirmed logout).
  - **multi-generation + isolation + eviction**: inject A into config
    gen 1, rotate to B into gen 2, confirmed logout → both generations
    removed; **eviction bound**: nine distinct rotations then logout,
    with an older generation carrying the first credential → retained +
    info log (the documented bounded-guarantee boundary, asserted);
    **store-key isolation**: fingerprints injected against store 1 never
    classify entries against store 2 (two store paths, logout in one, the
    other untouched), including symlinked and delete+rename-replaced
    stores resolving to the same key.
  - **hook integration**: post-login update payload exactly `{ model }`
    (never mcp, never keys); auto-pick re-read guard; **redaction
    assertions**: no credential material — current, historical, or from
    malformed records — appears in any log, warn, or error object
    (fingerprints only); symlink threat model: a user-controlled symlink
    is local configuration — anyone able to point auth.json elsewhere can
    already read the store directly; the read credential only ever goes
    to the fixed LunaRoute endpoints.
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
2. Verify `client.config.update` is live-only (acceptance criterion 7)
   and that the host resolves a single global auth store (observed
   cardinality documented; state is store-path-keyed regardless).
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
   rotated key? (j) **removal e2e on the supported reconciliation path** —
   branch-specific: if gate branch (a) holds (hook re-runs on reload),
   inject a key, remove it from auth.json, trigger the reload, and assert
   the plugin-managed entry is gone while a user-owned entry survives; if
   branch (b) holds (hook does not re-run), assert the same after a
   restart. **Gate branches** (recorded, not assumed) — outcomes stated
   **per surface**:
   (a) config hook re-runs on reload (any config-object lifecycle —
   fresh/clone/mutated; the value-shape rule handles all three) → MCP
   reconciliation (inject/refresh/remove) is automatic on reload; README
   says so for MCP.
   (b) config hook does not re-run on reload → MCP reconciliation is
   restart-only; README says "restart after login or rotation" for MCP.
   (c) chat loader recreates on reload → chat credential rotation is
   automatic; else restart-only for chat. Each surface (MCP, chat, models)
   is documented independently — "restart" is never claimed wholesale.
   No branch blocks the release; the spike result selects the branches.
   (i) **chat-loader reload**: does the instance reload recreate
   the provider/loader (fresh chat `apiKey` from the new auth-store entry)
   or keep the load-time snapshot? (Covered by gate branch (c) above.)
   The fixture is throwaway; production code starts at stage 2.

Results are recorded here (`engines.opencode`, peer dependency floor) before
the scaffold lands. Core dynamic model discovery
(anomalyco/opencode PR #42660) is unmerged and not required — our provider
hook + gateway catalog metadata is strictly richer than its ID-only discovery.

## Implementation staging

Ordered stages (detailed task breakdown goes in the implementation plan
document, per writing-plans):

1. Compatibility spike (above) — version lock + the verifications.
   1.5. **Spike decision record** (committed artifact, not paperwork): the
   decision record plus a minimal host-test harness land as a commit; the
   selected branch's integration test must pass before the MCP production
   stage (stage 6) proceeds. Every lifecycle statement — spec reload claims,
   README draft, acceptance checklist, implementation tasks — is updated
   to the selected branches.
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
   removal and auth.json recovery) + manual smoke checklist run against
   staging. The README carries a short **"MCP entry management"** section
   making the exact-shape collision behavior prominent: a hand-written
   `mcp.lunaroute` matching the plugin's shape has its header values
   refreshed by the plugin; to keep a custom entry, diverge its shape
   (e.g. `enabled: false` or an extra header).
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
