# Smoke Checklist — @lunaroute/opencode-extension (OpenCode v2)

**Status: headless spikes verified 2026-10-15 on opencode 2.0.29 (kata 4qqn); manual/TTY items pending.**

Run against staging before every release. Set the staging env vars before
starting OpenCode (for the shared background service use
`opencode service set env <NAME> <value>`, then `opencode service restart`):

```bash
export LUNAROUTE_ROUTING_URL=<staging gateway>/v1
export LUNAROUTE_API_URL=<staging api>
export LUNAROUTE_FRONT_URL=<staging front>
export LUNAROUTE_MCP_URL=<staging mcp>/mcp
```

Credentials live in the server's database (v2); `/connect` manages accounts.
Where to look:

- **Gateway logs** (staging): the attribution triple — `lunaroute-agent:
  opencode`, `x-lunaroute-session`, `lunaroute-session-id` — plus key
  `source: opencode`.
- **Staging MCP server logs**: `LUNAROUTE-API-KEY` header + `lunaroute-agent`
  + session id on MCP requests.
- **Server log**: `~/.local/share/opencode/log/opencode.log` (plugin load
  lines; note that plugin `console.*` output is not captured there on 2.0.x).

---

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

## Pending (need a TTY / browser / real key)

- [x] **TUI plugin loads** (2026-10-15, TTY via `script`): `/lunaroute`
  renders the settings list + Refresh models; toggling Hosted MCP wrote
  `lunaroute.json` and showed `mcp = off · applied`. TUI features are
  reported by `/api/plugin` (`server + tui`).
- [ ] **Browser (auto) OAuth**: `/connect` → LunaRoute → Log in with browser;
  approving in the browser completes without pasting.
- [ ] **First-class tools end-to-end**: with a real key, `web_search`
  executes; `generate_image` returns an attachment visible to a vision
  model; `convert_document` returns Markdown.
- [ ] **`/connect` pre-login listing**: LunaRoute listed before any login,
  with the three methods.
- [ ] **Logout/account switch**: switching accounts updates models, MCP
  headers, and tools after the credential event.
- [x] **Published tarball** (2026-10-15): `npm pack` + `file:<tarball>`
  install loads with `features: {server, tui}` and status active.
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

- [ ] **Gateway down at first load** -> exactly one `lunaroute/login` model named
  "Couldn't load models — run /lunaroute → Refresh models"; the server stdout carries
  `LunaRoute: catalog fetch failed: …` (not `opencode.log`).
- [ ] **Placeholder replaced, not merged** -> after the gateway recovers, Refresh models
  leaves only real models (`lunaroute/login` gone).
- [ ] **No auto-pick of the placeholder** -> with no default model set and a failed
  catalog, starting a session (TUI and `opencode run`) does not silently run
  `lunaroute/login`.
- [ ] **Placeholder is usable-shaped** -> select it and send a prompt: the gateway answers
  with a normal model error, the TUI reports it, nothing crashes.
- [ ] **Logged out** -> one `lunaroute/login` model named "Log in with /connect".
