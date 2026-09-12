# Settings Live-Apply Spike — Decision Record (kata f2aj gate)

Date: 2026-09-11 · OpenCode tested: **1.18.30** · Plugin pkg tested: 1.18.25 types · Method:
headless `opencode serve` (XDG-sandboxed under /tmp/lr-spike2) + fixture plugin
(`lr-spike-fixture`, registers `spike_tool` iff the scratch settings file says `on`) +
`@opencode-ai/sdk` driver (session.create → session.prompt; config.update = PATCH /config) +
fake OpenAI-compatible gateway capturing the **`tools` array offered to the model** on every
chat request (the observable — tool presence is what actually reaches the LLM).

## Question

Does the plugin **`tool` map rebuild per instance** after a config PATCH (instance disposal)?
I.e. can a settings write change the registered tool set **without a process restart** — the
pi "live apply" analog?

## Result

**YES — the tool map rebuilds per instance.** A/B/A within ONE serve process (new session per
turn, same process, fixture provider streaming throughout):

| Turn | Settings file | Trigger | `spike_tool` offered to the model? |
|---|---|---|---|
| 1 | `on` | fresh instance | **present** |
| 2 | `off` (file rewritten) | `PATCH /config` (status 200) | **absent** (0 occurrences in the turn's chat requests) |
| 3 | `on` (rewritten back) | `PATCH /config` | **present again** |

Reversible and deterministic. The tool map is built in the plugin factory's returned hooks;
its rebuild per instance implies the factory re-runs per instance (consistent with the compat
spike's gate (a): the config hook re-runs after PATCH).

## Decision (pre-written rule, applied)

**Live apply = write-first + PATCH trigger.** A settings write is followed by
`client.config.update({ config: { model: <current model> } })` — an idempotent no-op-style
write (the same verb the post-login default-model pick uses, compat-spike-proven) that marks
the instance for disposal; the next instance use rebuilds provider/MCP/tool state from the
fresh settings file. `writeSettings()` + an `applyViaReload(client)` helper land in phase 1;
the phase-2 `/lunaroute` TUI calls both (write-first, then apply). The registration-time gate
(web tools: settings + key + tools/list) re-evaluates on that rebuild — a toggled-off tool
disappears, a toggled-on tool appears, no restart.

Execute-time gating is **not** needed for availability — but the per-execute settings reads
already shipped in gygp stay (provider selection follows the file on the very next call even
without a reload; registration changes are what need the PATCH trigger).

## Plugin-loading observations on 1.18.30 (spike-environment, one machine)

- **Tarball-path config entries did not load** (silent — no factory run, empty package-cache
  dir). The compat spike proved this form on 1.18.25; **re-verify smoke item 6** (install from
  packed tarball) on 1.18.30 before the next release.
- **npm-name form loads**: resolved from the project's `node_modules`, or from OpenCode's
  package cache (`<cache>/opencode/packages/<name>@latest`) — pre-seeding that directory with
  the package works when the name is not on npm (the auto-install otherwise fails silently).
- **`console.log` from plugins is NOT visible** in headless serve stdout or the instance log —
  observe plugins via `client.app.log` (POST /log → instance log), gateway traffic, or file
  side effects. This directly informs f2aj's logging decision (PluginInput carries no logger;
  production logging must go through `client.app.log`).
- 1.18.30 chat requests **stream** (`stream: true`): a fake gateway must answer SSE chunks —
  a non-streaming JSON body causes an infinite session loop (thousands of steps).

## Consequences

- f2aj phase 1 ships: `writeSettings` (atomic), the PATCH-trigger helper, `mcpEnabled`
  gating the MCP reconciler, image/convert toggle decision fns (consumers land with katas
  5715/gv7t), the `client.app.log` production logger, and the default-model feedback line.
- README documents live-apply semantics: file/env edits apply on the next instance
  (restart or any PATCH-triggered reload); the future `/lunaroute` command applies
  immediately via the trigger.
- Smoke checklist: add a live-apply item (flip `webTools` off, PATCH/reload, tool disappears);
  re-verify item 6 (tarball load) on 1.18.30.
