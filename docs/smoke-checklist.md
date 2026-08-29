# Smoke Checklist — @lunaroute/opencode-extension

**Status: Pending manual run — blocks release (Task 10).**

Run against staging before every release. Set the staging env vars before
starting OpenCode:

```bash
export LUNAROUTE_ROUTING_URL=<staging gateway>/v1
export LUNAROUTE_API_URL=<staging api>
export LUNAROUTE_FRONT_URL=<staging front>
export LUNAROUTE_MCP_URL=<staging mcp>/mcp
```

Auth store: `~/.local/share/opencode/auth.json` (back it up before you
start; deleting/editing entries is part of the checklist). "Config files"
below means: global `~/.config/opencode/opencode.json`, the project
`opencode.json`, and the instance `config.json` OpenCode writes next to the
project — check all of them wherever "config files" is named.

Where to look:

- **Gateway logs** (staging): the attribution triple — `lunaroute-agent:
  opencode`, `x-lunaroute-session`, `lunaroute-session-id` — plus key
  `source: opencode`.
- **Staging MCP server logs**: `LUNAROUTE-API-KEY` header + `lunaroute-agent`
  + session id on MCP requests.
- **auth.json**: the `lr_` key lives here and nowhere else.

---

## Spike-deferred items (run these first)

- [ ] **0a — TUI `/models` picker shows LunaRoute models before first use.**
  Open `/models` right after login, before any chat. LunaRoute models must
  be listed and selectable. (The headless spike could not verify the
  session-runner's pre-build availability gate. If this fails, the
  post-login default-model auto-pick is the documented mitigation — note
  the failure and continue.)
- [ ] **0b — Browser flow against staging end-to-end.** `/connect` →
  LunaRoute → Log in with browser → the browser opens
  `<staging front>/device-auth/opencode` → approve → OpenCode reports
  success and the key lands in auth.json only.

## Spec acceptance criteria

- [ ] **1 — `/connect` browser flow + rotation.** Browser flow completes;
  key lands in auth.json only. Run it twice in a row (re-login): the
  credential is replaced, and after the instance reload (or a restart) MCP
  requests carry the **new key and the current session attribution**
  (verify on the staging MCP server: `LUNAROUTE-API-KEY` +
  `lunaroute-agent` + session id — check after the first login and again
  after the re-login).
- [ ] **2 — Models + chat + attribution.** `/models` shows LunaRoute models
  with correct names; select one and chat; gateway logs show the
  attribution triple (and `source: opencode` on the key).
- [ ] **3 — Browser cancellation.** Start the browser flow, never approve:
  auth fails after 3 minutes, nothing is stored, no dangling listener (the
  loopback port is released — `ss -tlnp | grep <port>` is clean).
- [ ] **4 — Revoked key.** Revoke the staging key server-side, then open
  `/models`: no LunaRoute models (fetch 401 → empty list, no crash); chat
  with a previously-selected model fails with the gateway's 401 surfaced
  by OpenCode — no silent use of an empty model.
- [ ] **5 — Logged out entirely.** Remove the `lunaroute` entry from
  auth.json and restart OpenCode: no `mcp.lunaroute` in the live config, no
  LunaRoute models, one info log line ("Run /connect..."), no errors.
- [ ] **6 — Install from the packed tarball.** `npm pack`, then install the
  tarball into a fresh OpenCode (config `plugin` array pointing at the
  tarball path) — not a repo checkout. The plugin loads and `/connect`
  works. Proves the package loads from npm.
- [ ] **7 — No secrets in config files.** After login + the post-login
  default-model update: no config file contains the key or an
  `mcp.lunaroute` entry written by the plugin; the instance `config.json`
  may gain **only** the `model` field; global `opencode.json` untouched
  (`diff` it against a copy made before login).
- [ ] **8 — User-owned config survives.** With `provider.lunaroute.options.baseURL`
  pre-set and a hand-written diverged `mcp.lunaroute` (e.g. `"enabled": false`
  or a different URL) in the config: restart — both survive untouched; then
  `/connect` re-login — both are still untouched and the info log fires
  ("user-defined mcp.lunaroute in effect").

## Task 8 review mitigation

- [ ] **9 — Model-not-overwritten negative case.** With a default model
  already set in the config (e.g. `anthropic/...`), run `/connect` re-login:
  the default model is **not** changed by the post-login auto-pick (the
  auto-pick only fires when no default is set).

---

Result: _pending_ (all items PASS → release may proceed; any FAIL → fix,
re-run, note the fix in the release commit message).
