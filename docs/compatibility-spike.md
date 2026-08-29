# Compatibility Spike — Decision Record (Task 1 gate)

Date: 2026-08-29 · OpenCode tested: 1.18.25 (primary) + 1.14.49, 1.14.17 (floor probes) · Plugin pkg tested: 1.18.25

Method: headless (controller ruling) — `opencode serve`/CLI + fake gateway (127.0.0.1:4599) + packed raw-TS
fixture plugin + direct auth.json writes simulating `/connect`. XDG sandbox (`XDG_DATA_HOME`/`XDG_CONFIG_HOME`/
`XDG_CACHE_HOME` under /tmp) protected the user's real files. Evidence trail: `/tmp/lr-spike/` (scratch, kept
for Task 1 review; not committed).

| Question | Result |
|---|---|
| Minimum OpenCode version (provider + chat.headers hooks) | **`>=1.14.49`** — types exist since 1.14.17, but 1.14.17 crashes in the models-listing path with a config-injected provider (`undefined is not an object (evaluating 'u.api.id')`; clean without the plugin). 1.14.49 works fully (models listed, chat reached the gateway with the stored key). Corroborated by opencode-omniroute-auth's production compat note (same boundary). 1.18.25 verified end-to-end. |
| Auth-store path (Linux) / (macOS) | **`$XDG_DATA_HOME || ~/.local/share` + `/opencode/auth.json`** — strace-verified on Linux (single `O_RDONLY` open of the sandboxed path); source-verified via `xdg-basedir` (same resolution on macOS; Windows untested, out of v1 scope) |
| config.update persists to | `PATCH /config` (POST does not exist on 1.18.25) — deep-merge into **`<project dir>/config.json`**; only our key written (verified: file contained exactly `{"model":"lunaroute/model-a"}` after the update) |
| Config-hook MCP injection persists? | **No** — live config only (verified: grep over every JSON under data/config/run dirs finds the key only in auth.json; the 1.14.49 run also probed `GET /mcp` on the fake gateway, proving the injected entry is live in the MCP client) |
| Gate (a): config hook re-runs on instance reload? | **Yes** — after `PATCH /config` (instance marked for disposal), the next instance use re-ran "fixture loaded" + "config hook ran (run #2, #3)" |
| Gate (b): if no → README says restart-required for MCP | n/a — gate (a) is yes |
| Gate (c): chat loader re-created on reload? | **Yes (new instances read fresh auth.json)** — key rotated to `lr_good2`, a new run picked it up with no server restart (`bearer=lr_good2` at the gateway). The auth loader runs per-instance at first provider build. |
| Packed raw-TS tarball loads | **Yes** — default-export Plugin from `main: "./index.ts"`, packed with npm, loaded from the config `plugin` array on 1.14.49 and 1.18.25 |
| ModelV2 shape accepted | **Yes on 1.14.49+** — `{id, name, providerID, limit, api:{id,url,npm}}` registers, lists in `opencode models`, and chats. 1.14.17 requires the `api` field (crashes without it — our production shape always emits it). |

## CRITICAL design revision (overrides spec/plan mechanism)

**The plugin `provider` hook never fires for custom config-declared providers.** Verified two ways:

1. Source (anomalyco/opencode, provider registry build): the plugin provider-hooks loop runs **before** config
   providers are merged into the provider database and gates on `database[providerID]` existing — a custom
   provider id (not in models.dev) is skipped (`if (!provider) continue`). Config providers join the database
   only in a later step.
2. Empirical: zero "provider hook ran" log lines across every instance on 1.14.49 and 1.18.25, while the same
   fixture's config hook and auth loader fired reliably.

**Consequence — models must be injected by the `config` hook** (fetch `GET {routingUrl}/models` in the config
hook using the key resolved from auth.json, map, inject into `cfg.provider.lunaroute.models`), exactly the
community pattern (opencode-dynamic-custom-providers, opencode-models-discovery). The spec's "provider hook
owns models" mechanism is dead on current OpenCode; Task 6/8 of the plan must move the catalog fetch into the
config hook (reusing mcp.ts's `resolveAuthState` for the key). Drop the `provider` hook from the plugin
entirely — it cannot fire for us.

## Observed behaviors that bind the implementation

- **Auth loader runs lazily at first provider build** (not at registry build): serve instances that never chat
  never run the loader; the first model use (even the session-title agent) runs it. The loader's returned
  options set `request.body.apiKey`, which the catalog's `available()` filter requires.
- **Availability wrinkle (unresolved headless)**: the serve session-runner path rejected
  `lunaroute/model-a` as "Model unavailable" before the first provider build (the catalog gate above), while
  `opencode models`, `GET /config/providers`, and the CLI run path all resolve it. The TUI first-pick flow
  (open /models, pick a LunaRoute model before any chat) is **unverified headless** and must be the first
  Task 9 smoke item. Mitigations if it fails: the post-login `{ model }` auto-pick (proven to work —
  `opencode run` with no `--model` picked up `config.model` and chatted) makes the provider build happen on
  first prompt.
- **Plugin cache**: same-name+version tarball changes are NOT picked up — bump the fixture/package version
  when iterating (burned ~15 min on this).
- **Config hook may run multiple times per process** (per instance creation/reload) — injection must be
  idempotent (ours is: same values re-assigned).
- `PATCH /config` is the update verb on 1.18.25 (the SDK's `client.config.update` tracks its server
  generation; we pin the plugin peer dep to match).
- Instance creation is lazy (first session/use), not at `serve` boot.

## Consequences

- **engines.opencode: `>=1.14.49`** (Task 2 package.json)
- **resolveAuthStorePath data-dir resolution** (Task 7): `${XDG_DATA_HOME || <home>/.local/share}/opencode/auth.json`
  (xdg-basedir semantics; macOS same, Windows unsupported in v1)
- **README MCP/rotation wording: reload-automatic** — MCP injection refreshes when the instance reloads after
  the post-login `{ model }` update (gate (a) yes); rotation picks up on the next instance without a process
  restart (gate (c) yes). A restart also works; the README should not claim it is required.
- **Task 6/8 plan change** (per CRITICAL section above): catalog fetch + model injection move into the config
  hook; drop the provider hook.
- **Task 9 smoke additions**: (1) TUI /models picker shows LunaRoute models before first use; (2) browser flow
  against staging (`/device-auth/opencode`) — both deferred from this spike.

## Side effects

- One un-sandboxed strace probe (missing env in that shell) caused the binary to create
  `~/.local/share/opencode/opencode.db*` and append log lines in the user's real data dir (the dir pre-existed
  with `log/` and `repos/`; nothing was read, overwritten, or deleted — additive db/log files only). All other
  runs were XDG-sandboxed.
