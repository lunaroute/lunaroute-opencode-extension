# OpenCode v2 plugin API port — design

Kata 4qqn. Status: approved decisions locked (see kata comments), implementation starting.
Evidence: `.worktrees/4qqn-v2-plugin-api-port.review.md` (fresh-eyes review, live-verified on
opencode 2.0.29) and the kata 4qqn body/comments.

## Intent

OpenCode v2 hard-breaks the v1 plugin API. The v1 plugin's default export is a function
returning `{ config, auth, "chat.headers", tool, dispose }`; v2 requires
`Plugin.define({ id, setup(ctx) })` from the version-locked `@opencode/plugin` package
(`failed to load plugin ... Plugin must export a default definition with an id and an effect
or setup function`). Result on v2.0.29: the plugin is skipped with a log warning and every
LunaRoute feature disappears.

This port makes the plugin a first-class v2 plugin on OpenCode >= 2.0.0 and keeps v1 users
on the frozen 0.3.1 line.

## Goals

- Provider + model catalog on v2 (Responses default, completions kill switch unchanged).
- `/connect` login works natively through v2 integrations; existing v1 keys keep working.
- Attribution headers, hosted MCP, and all first-class tools (web/image/convert) work on v2.
- `/lunaroute` TUI settings still work, plus a new `models-refresh` action.
- Unit suite and live spikes prove each seam on opencode 2.0.29.

## Non-goals

- v1 compatibility in the new release (0.3.x is frozen; pin documented).
- Classifier models / image sizing / detect-and-backfill parity with the Pi extension
  (Pi-only or deliberately dropped; possible follow-ups, not this kata).
- Feedback command kata 3g0t (not in 0.3.1; unaffected).

## Locked decisions

1. v2-only, released as **1.0.0**; README + release notes tell OpenCode 1.x users to pin
   `@lunaroute/opencode-extension@0.3.1`.
2. TUI port + `models-refresh` in scope.
3. No placeholder model. v2 `/connect` lists integrations, not models; verify zero-model
   provider visibility in the login spike.
4. Logging sink: `console.*`; verify capture in `opencode.log` during the spike.
5. Integration id **must be `lunaroute`** (legacy `auth.json` import verified to land under
   exactly this id, keeping existing logins).
6. Auth methods: native `key` method; OAuth methods for browser (mode `auto`) and remote paste
   (mode `code`). Spike the static-key-as-`Credential.OAuth` shape (refresh `""`, far-future
   `expires`) before close.
7. MCP: transform redesign, async credential resolved beforehand and captured in the closure;
   `disabled` not `enabled`; no fingerprint/logout machinery.
8. Verification on the v2 seam (fake ctx for unit tests; live spikes listed below). No v1-path
   smoke of the new package.
9. Wire format packages: `@opencode/ai/providers/openai-compatible-responses` (default) and
   `@opencode/ai/providers/openai-compatible` (completions).
10. Packaging: `dependencies: { "@opencode/plugin": "2.0.29" }` (exact pin, re-verified per
    opencode bump), exports `"."` + `"./tui"`, `engines.opencode >= 2.0.0`, drop
    `@opencode-ai/plugin`.

## Verified mechanics (2.0.29, live)

- `Plugin.define({ id, setup })` loads under v2; v1 `server()` is ignored.
- `ctx.provider.transform((editor) => editor.add({ info, models }))` materializes the provider
  (`GET /api/provider`) and models (`GET /api/model`); `opencode run --model <p>/<m>` selects
  them. Transforms are synchronous by contract; async work happens outside and is captured.
- `ctx.integration.transform` registers methods (`GET /api/integration`); a `key` credential
  created/activated through the native flow is auto-attached by OpenCode to provider requests
  as `Authorization: Bearer <key>` — no plugin-side auth loader.
- `ctx.session.hook("model.request", cb, { providerID })` headers reach the wire.
- `ctx.mcp.transform` registers `{ type: "remote", url, headers: {...}, disabled: false }`.
- `ctx.event.subscribe` delivers `credential.updated` / `credential.switched` — the post-login
  refresh trigger. `ctx.provider.reload()` / `ctx.model.reload()` re-play transforms.
- `Model.Info`: `cost` is a tier array; `variants` are `[{ id, settings }]`; capabilities,
  `limit`, per-model `package`/`settings` exist; `Model.Info.default(providerID, id)` is the
  base object (spread a copy before overriding).
- v2 reads `opencode.json.plugins` (legacy `plugin` key is normalized) and auto-installs npm
  packages; one entry loads both server and `./tui`.
- `client.location.reload()` exists for settings live-apply; RPC (`ctx.rpc.register` +
  TUI `context.client.rpc(Def)`) is available for `models-refresh`.

## Mapping (v1 -> v2)

| v1 | v2 |
|---|---|
| `config` stub + models + MCP | `provider.transform` + `model.transform` + `mcp.transform` |
| `auth` hook (loopback/paste/code) | `integration.transform`: OAuth methods (`auto`/`code`) + `key` method, provider `integrationID` |
| credential from `auth.json` | `integration.connection.active` + `resolve` (legacy import covers old keys) |
| post-login default pick via `config.update` | credential event -> refetch -> model transform `default.set` when unset |
| `chat.headers` | `session.hook("model.request", …, { providerID })` |
| `tool` map, zod args | `tool.transform`, JSON Schema input, `{ output, content, metadata }` results |
| MCP reconciler | synchronous transform over captured credential; `reload()` on change |
| `dispose` | cleanup returned from `setup` (or registration.dispose) |
| `/lunaroute` TUI (v1 API) | `@opencode/plugin/tui` `define` + `keymap.layer` slash + `ui.dialog.select` + toasts |
| N/A | `models-refresh` RPC method + TUI action |

## Phases

1. Scaffold: package.json (deps/exports/engines), entry `Plugin.define`, fake-ctx test harness.
2. Catalog: `MappedModel` -> `Model.Info` mapping + provider/model transforms + reload triggers.
3. Integration/auth: methods, provider `integrationID`, credential reader, post-login pick.
4. Request hooks + MCP transform.
5. Tools: JSON Schema inputs, v2 results, lazy credential via connection.
6. TUI + models-refresh RPC + settings live-apply.
7. Verification: ported unit suite, live spikes, README/CHANGELOG, published-tarball load.

## Verification

Unit: ported suite on the v2 seam (pure logic tests survive; entry/hook tests use a fake ctx).
Live spikes on 2.0.29 (rig pattern in the review report): plugin loads; `/connect` login
(including the OAuth-`expires` question); provider + models list; credential lands as
`Authorization: Bearer`; attribution headers on the wire; MCP connects to the hosted server;
tools register + execute; settings toggle applies live via `location.reload()`; `models-refresh`
RPC; TUI loads in a real TTY; published tarball loads. Re-run the provider-materialization
check on every opencode bump while upstream #51802/#42856 remain open.

## Risks

- Upstream API is young and version-locked to opencode releases; exact-pin `@opencode/plugin`
  and re-run the smoke per bump.
- OAuth-for-static-key `expires` semantics unverified (P1-1).
- `console.*` log capture unverified on this platform (P1-2).
- TUI live load cannot be tested headless; needs a real TTY.
