# Smoke Checklist — @lunaroute/opencode-extension (OpenCode v2)

**Status: headless items verified 2026-10-15 on opencode 2.0.29 (kata 4qqn);
manual/TTY items below remain pending and must be run before the next release.**

Run against production before every release. No environment setup is needed:
the plugin's baked-in defaults point at the production services
(`gw.lunaroute.com`, `api.lunaroute.com`, `app.lunaroute.com`,
`mcp.lunaroute.com`; see `src/lunaroute.ts`). There is no staging
environment; every item below is runnable against production or a local host,
and anything that could not be run that way has been deleted rather than left
pending.

Credentials live in the server's database (v2); `/connect` manages accounts.
Where to look while running the items:

- **Gateway logs** (production, via the server's log access): the attribution
  triple — `lunaroute-agent: opencode`, `x-lunaroute-session`,
  `lunaroute-session-id` — plus key `source: opencode`.
- **Hosted MCP server logs**: `lunaroute-api-key` header + `lunaroute-agent`
  + session id on MCP requests.
- **Local server log**: `~/.local/share/opencode/log/opencode.log` (plugin
  load lines; note that plugin `console.*` output is not captured there on
  2.0.x).

## Verified headless (2026-10-15, opencode 2.0.29)

- [x] **Plugin loads**: `opencode plugin list` → `lunaroute local`; no
  `failed to load plugin` in the server log.
- [x] **Integration + methods**: `/api/integration` lists `lunaroute` with
  `browser`, `remote`, and `key` methods.
- [x] **Provider + catalog**: after a key login, `/api/provider` and
  `/api/model` list `lunaroute` models with the expected wire package
  (`LUNAROUTE_API=completions` → `@opencode/ai/providers/openai-compatible`).
- [x] **Credential on the wire**: catalog and model requests carry
  `Authorization: Bearer <key>` (attached by OpenCode from the credential
  via `integrationID`).
- [x] **Attribution**: model requests carry `lunaroute-agent`,
  `lunaroute-session-id`, `x-lunaroute-session`.
- [x] **OAuth (code/remote) roundtrip**: `integration.oauth.connect` →
  device URL + state; `integration.oauth.complete` with a pasted
  `code=...&state=...` → exchange → stored `method: "oauth"` credential;
  the next model request used `Bearer <access>` (static-key-as-OAuth shape,
  far-future `expires`, no `needs_auth`/refresh).
- [x] **MCP registration**: hosted URL received initialize/tools-list
  requests with `lunaroute-api-key` + attribution headers.
- [x] **Unit suite**: `npm run check` green.
- [x] **TUI plugin loads** (2026-10-15, TTY via `script`): `/lunaroute`
  renders the settings list + Refresh models; toggling Hosted MCP wrote
  `lunaroute.json` and showed `mcp = off · applied`. TUI features are
  reported by `/api/plugin` (`server + tui`).
- [x] **Published tarball** (2026-10-15): `npm pack` + `file:<tarball>`
  install loads with `features: {server, tui}` and status active.

## Pending (need a TTY / browser / real key — run before the next release)

- [ ] **Browser (auto) OAuth**: `/connect` → LunaRoute → Log in with browser;
  approving in the browser completes without pasting.
- [ ] **First-class tools end-to-end**: with a real key, `web_search`
  executes; `generate_image` returns an attachment visible to a vision
  model; `convert_document` returns Markdown.
- [ ] **`/connect` pre-login listing**: LunaRoute listed before any login,
  with the three methods.
- [ ] **Logout/account switch**: switching accounts updates models, MCP
  headers, and tools after the credential event.
- [ ] **OpenCode 1.x pin**: `@lunaroute/opencode-extension@0.3.1` still
  installs and loads on 1.18.30.

## Per-openCode-bump regression (cheap)

The v2 plugin API is version-locked and young. On every opencode update:

- [ ] `opencode plugin list` shows lunaroute active; server log has no
  `failed to load plugin`.
- [ ] `/api/provider` lists the provider; a model run reaches the gateway
  with `Authorization` + attribution headers (upstream issues
  anomalyco/opencode#51802 / #42856 watch: plugin-added providers must
  materialize).

## Catalog-fetch resilience (kata xn2w)

*Verified 2026-10-22 on opencode 2.1.2 (sandboxed HOME, worktree plugin entry, stub
gateway). The TUI/CLI print model ids only, so the placeholder's display name is pinned by
the unit tests (`tests/provider.test.ts`), not by this run.*

- [x] **Gateway down at first load** -> exactly one `lunaroute/login` model (was an empty
  provider before this change); `opencode serve` stdout carries
  `LunaRoute: catalog fetch failed: HTTP 500` (not `opencode.log`).
- [x] **Placeholder replaced, not merged** -> after the gateway recovered,
  `opencode reload` left only `lunaroute/glm-5.3` + `lunaroute/glm-5.3-flash`;
  `lunaroute/login` was gone. `editor.add` replaces the provider's model set, so no
  explicit removal is needed.
- [x] **No auto-pick of the placeholder** -> with no default model set and a failing
  catalog, `opencode run` resolved `build · flint-40b-free` (an OpenCode model), never
  `lunaroute/login`; the auto-pick after a *successful* reload logged
  `set lunaroute/glm-5.3-flash as the default model`.
- [x] **Placeholder is usable-shaped** -> `opencode run --model lunaroute/login` reached
  the gateway and surfaced `Provider request failed with HTTP 501` as a normal error; no
  crash.
- [x] **Logged out** -> exactly one `lunaroute/login` model (credential row deactivated).
## Release record (machine-checked)

The release commit — the commit the `v*` tag points at — must carry a line:

```
smoke: <YYYY-MM-DD> <all-pass|exceptions>[ note...]
```

`all-pass` means every checklist item above is checked or verified;
`exceptions` must be followed by a short note naming each item left open
and why. The publish workflow enforces the line's presence and shape via
`scripts/release-tag.mjs` before `npm publish` runs; a tag whose commit
lacks a valid smoke line fails the release. This enforcement begins with
the first release tagged after 2026-10-16.
