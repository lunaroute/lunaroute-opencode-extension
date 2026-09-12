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

## Pre-login onboarding (dpd0)

- [x] **P1 — `/connect` lists LunaRoute before first login.** Fresh machine
  state (no `lunaroute` entry in auth.json, plugin-only config): open the
  TUI, run `/connect` — LunaRoute must appear in the provider list;
  selecting it must show the three login methods.
  *Verified 2026-09-12 on OpenCode 1.18.30 (kata 3xsy): fresh XDG sandbox,
  npm-name install of published 0.1.2 → `GET /provider` (the exact list the
  TUI /connect dialog renders, source-verified dialog-provider.tsx) lists
  `lunaroute` with the `login` placeholder model. TUI dialog itself not
  driven interactively (headless verify). Login-method picker not exercised
  (covered by 0b/1).*
- [ ] **P2 — `/models` pre-login shows exactly one LunaRoute entry:**
  "Log in to load models" (the placeholder), no catalog entries.
- [ ] **P3 — Placeholder replaced after login.** Complete the login (see
  0b): `/models` shows the real catalog, "Log in to load models" is gone,
  and the post-login default-model auto-pick still lands on a real model.
- [ ] **P4 — User-set models are never clobbered.** With
  `provider.lunaroute.models` hand-written in opencode.json and logged
  out: restart — the hand-written models survive unchanged and no
  placeholder is added.

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
  by OpenCode — no silent use of an empty model. Note: with a shape-valid
  but dead credential, `/connect` may not list LunaRoute (zero models,
  valid state — no placeholder by design); re-auth via
  `opencode providers login --provider lunaroute`.
- [ ] **5 — Logged out entirely.** Remove the `lunaroute` entry from
  auth.json and restart OpenCode: no `mcp.lunaroute` in the live config,
  no catalog models (exactly the "Log in to load models" placeholder
  remains, and `/connect` still lists LunaRoute), one info log line ("Run
  /connect..."), no errors.
- [x] **6 — Install from the packed tarball.** `npm pack`, then install the
  tarball into a fresh OpenCode (config `plugin` array pointing at the
  tarball path) — not a repo checkout. The plugin loads and `/connect`
  works. Proves the package loads from npm.
  *Verified 2026-09-12 on OpenCode 1.18.30 (kata 3xsy): REGRESSED — the
  tarball-path entry does not load at all (silent, zero log lines;
  `lunaroute` absent from `GET /provider`). Loaded on 1.18.25 per the
  compat spike. The npm-name form (`"@lunaroute/opencode-extension"`)
  is the only working install form on ≥ 1.18.30 and is the only one the
  README documents; package-cache poisoning below also found.*
  *Cache finding: `Npm.add` (opencode core/src/npm.ts) returns an existing
  `<cache>/opencode/packages/@lunaroute/opencode-extension@latest` dir
  without ever re-checking npm — any cached pre-0.1.2 copy (no placeholder
  model) keeps running and hides LunaRoute from `/connect`. Reproduced and
  verified: `rm -rf ~/.cache/opencode/packages/@lunaroute` → next start
  fetches fresh 0.1.2 → provider lists again. Documented in README
  Troubleshooting.*
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

## Web search, first-class `web_search` (kata gygp)

- [ ] **W1 — First-class web_search registered.** Logged in, restart
  OpenCode: `web_search` is callable (ask the agent to search something);
  the tool output carries normalized results (title/url/snippet/date). The
  MCP duplicate (`lunaroute_web_search`) also exists — expected, documented
  coexistence.
- [ ] **W2 — Attribution on the search path.** Staging MCP server logs show
  `LUNAROUTE-API-KEY` + the attribution triple on the direct web_search
  calls (not just on `mcp.lunaroute` traffic).
- [ ] **W3 — Provider selection.** With
  `~/.local/share/opencode/lunaroute.json` set to `{"searchProvider": "brave"}`:
  a search without a provider arg uses brave (per the server's echoed
  provider), the next call after removing the setting follows the file
  (server default), and a per-call `provider` argument beats both.
- [ ] **W4 — Disable paths.** `LUNAROUTE_WEB_TOOLS=off` + restart → no
  `web_search`; unset env + `{"webTools": "off"}` + restart → none; remove
  the settings file → the tool is back.
- [ ] **W5 — Logged out / login timing.** Remove the `lunaroute` entry from
  auth.json and restart: no `web_search` registered. Log back in
  mid-session: the tool appears after the instance reload (restart always
  works); a stale registered tool fails with the run-`/connect` error, never
  a stale-key call.
- [ ] **W6 — web_fetch stays dormant.** The hosted server does not offer a
  fetch tool today: `web_fetch` must NOT be registered (it lights up
  automatically when the server ships one).

## Settings (kata f2aj)

Settings file: `$XDG_DATA_HOME/opencode/lunaroute.json` (default
`~/.local/share/opencode/lunaroute.json`). See README "Settings".

- [ ] **S1 — webTools toggle + env hatch.** With `{"webTools": "off"}` +
  restart: no `web_search`; remove the file + restart: it is back.
  `LUNAROUTE_WEB_TOOLS=off` wins over the file (tool stays off even with
  `"webTools": "on"` in the file).
- [ ] **S2 — MCP toggle isolation.** With `{"mcp": "off"}` + restart: no
  `mcp.lunaroute` in the live config, but LunaRoute models are listed and
  `web_search` still registers (the pi bjy9 early-return bug must not
  reproduce here).
- [ ] **S3 — Malformed settings file.** Write `{oops` into the settings file
  and restart: exactly a warn (not a crash), session works with defaults,
  and the instance log carries the reason.
- [ ] **S4 — Default-model feedback.** Fresh state (no default model set),
  `/connect` login: the instance log records the auto-pick ("set
  lunaroute/<id> as the default model (change with /models)").
- [x] **S5 — Re-verify item 6 on OpenCode 1.18.30.** The live-apply spike
  ([docs/settings-live-apply-spike.md](./settings-live-apply-spike.md))
  observed tarball-path plugin entries NOT loading on 1.18.30 (they loaded
  on 1.18.25); confirm the npm-pack install path still works before
  release, and adjust the README install instructions if it regressed.
  *Verified 2026-09-12 (kata 3xsy): regression confirmed — tarball path
  silently does not load on 1.18.30 (see item 6). README already documents
  npm-name only; unchanged. The npm-name form verified working on 1.18.30
  with published 0.1.2 (P1) and with the stale-cache recovery path.*

## TUI settings command, `/lunaroute` (kata 7pd6)

See README "Settings → `/lunaroute` settings command". The command runs in a
TUI plugin declared in `tui.json` (`plugin` array); the dense loading-spike
findings are in
[docs/tui-plugin-loading-spike.md](./tui-plugin-loading-spike.md).

- [ ] **T1 — Plugin loads + command present.** Install via
  `opencode plugin @lunaroute/opencode-extension` (or the npm-name form from
  the project's `node_modules`), confirm the entry is in `tui.json`, start the
  TUI: typing `/lunaroute` shows "LunaRoute settings" (not "No matching
  items"). **Unverified in the 7pd6 spike sandbox** — there the external TUI
  module was never imported despite a correct manifest/`tui.json`; confirm on
  a real published/installed package and record the result here.
- [ ] **T2 — Settings list + write.** The dialog lists all five keys with
  their current values; selecting a toggle flips it, persists
  `lunaroute.json` (0600, tmp+rename), toasts success, and the list refreshes.
- [ ] **T3 — Live apply.** Toggle `webTools` off from `/lunaroute`: the tool
  disappears without a restart (mirrors the f2aj A/B/A in
  docs/settings-live-apply-spike.md); toggle back on: it returns.
- [ ] **T4 — Write-first on failure.** Make the settings file/dir unwritable
  (e.g. `chmod 0500` the dir): toggling shows an error toast, leaves the file
  unchanged, and does not trigger a reload.
- [ ] **T5 — Headless fallback.** With the TUI plugin not loaded, `/lunaroute`
  is absent and settings are still controlled by the file + env hatches.

## Image tools (kata 5715)

- [ ] **I1 — All three registered.** Logged in + server offers them +
  restart: `generate_image`, `edit_image`, `upload_image` are callable; the
  MCP duplicates (`lunaroute_generate_image`, …) also exist — expected.
- [ ] **I2 — Vision loop.** Ask the agent to generate an image: the result
  carries a `file://` attachment and the saved path under
  `~/.local/share/opencode/lunaroute-images`; a vision model then describes
  the image without re-reading it.
- [ ] **I3 — Model enum from the server.** The `model` parameter only
  accepts the per-org values (wrong id → validation error naming the
  allowed models).
- [ ] **I4 — upload_image safety.** Point `path` at a non-image (e.g. a
  text file with secrets): the tool refuses locally, nothing is uploaded
  (staging MCP logs show no request); a >11 MiB image is refused with the
  ceiling message.
- [ ] **I5 — imageTools toggle.** `{"imageTools": "off"}` or
  `LUNAROUTE_IMAGE_TOOLS=off` + reload/restart: all three gone; re-enable:
  back without a process restart (PATCH-triggered reload or restart).
- [ ] **I6 — Edit flow.** generate → pass the id to edit_image → new id +
  saved file; upload a local png → id → edit it.

## Document conversion (kata gv7t)

- [ ] **C1 — Registered + inline conversion.** Logged in + server offers it
  + restart: `convert_document` callable; a docx/pdf converts to inline
  Markdown; the MCP duplicate (`lunaroute_convert_document`) also exists —
  expected, documented endgame.
- [ ] **C2 — Local safety.** Point `path` at a non-document (e.g. `.env` or
  a private key): refused locally, no upload in the staging MCP logs; a
  `.csv` converts; a PNG renamed `notes.csv` is sniffed as an image and
  converted through the OCR path, never read as text.
- [ ] **C3 — Oversized output fallback.** A document whose conversion
  exceeds the inline cap: exactly one retry, the full markdown saved under
  `~/.local/share/opencode/lunaroute-docs` (private permissions), path
  returned with the document's opening lines.
- [ ] **C4 — convertTools toggle.** `{"convertTools": "off"}` or
  `LUNAROUTE_CONVERT_TOOLS=off` + reload/restart: the tool is gone;
  re-enable: back without a process restart.

---

Result: _pending_ (all items PASS → release may proceed; any FAIL → fix,
re-run, note the fix in the release commit message).
