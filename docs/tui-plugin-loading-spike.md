# TUI-plugin loading spike (kata 7pd6) — findings

Date: 2026-09-12 · OpenCode 1.18.30 (`~/.opencode/bin/opencode`) · sandbox `/tmp/lr-spike2`

## Question

The kata's vehicle is a TUI plugin (`/lunaroute` slash command + dialog + toast,
running outside the prompt loop). The f2aj phase-2 research left one open
question: **what is the TUI-plugin loading/packaging path on current OpenCode,
and does it actually load?** This spike answers it.

## Method

Extend the f2aj live-apply sandbox with a package that ships both halves, drive
the real TUI in a pty (`script -qec`, timed keystrokes), and observe via
append-only file markers (console is invisible headless, `client.app.log` needs
a live client). Process facts pinned: `plugin` config key in an ordinary
`opencode.json` is **not** the TUI path.

## Established facts (evidence-backed)

1. **TUI plugins are declared in `tui.json`, not `opencode.json`.**
   Config sources, in order: `<XDG_CONFIG_HOME>/opencode/tui.json` (global),
   `<project>/.opencode/tui.json` (local), `$OPENCODE_TUI_CONFIG`.
   Verified: OpenCode logs `loading tui config` / `applying tui config` for both
   the global and project files when they carry a `plugin` array.

2. **Manifest contract.** A package exposes targets via `package.json`:
   - `exports["./server"]` (or `main`) → server plugin
   - `exports["./tui"]` → TUI plugin
   `opencode plugin <pkg>` (the official installer) reports
   `Detected server + tui targets` and writes both `opencode.json` and
   `tui.json` in the chosen scope. Verified end-to-end.

3. **Default-export shape is the object form, never a bare function.**
   `{ id, server() }` or `{ id, tui() }` — a package must not export both in one
   module. Verified: a bare-function server default is silently rejected;
   switching to `{ id, server() }` made the server module load (markers fired).

4. **The TUI plugin runtime itself works.** OpenCode's own built-in TUI plugins
   register slash commands and appear in the palette: `/diff` (diff-viewer),
   `/models`, `/mcps`, `/debug`, `/help` all render. So the command palette and
   plugin runtime are functional.

## The blocker

With every one of the above satisfied — `tui.json` listing the package (global
+ project), `exports["./tui"]` present and installer-confirmed, the package
present in the project `node_modules`, `.opencode/node_modules`,
`<config>/opencode/node_modules` and the OpenCode package cache, versions bumped
to avoid stale caches — **the TUI module is never imported.**

Observables:
- A top-level `appendFileSync` marker in `tui.ts` never fires → the module is
  never evaluated (not merely failing at init).
- No `[tui.plugin]` error, no `failed to load tui plugin`, no
  `skipping invalid tui config` anywhere in the pty capture or
  `<data>/opencode/log/opencode.log`.
- The server half of the *same package* loads fine in the same run.

So external TUI-plugin import is dropped silently on 1.18.30 in this sandbox.
The loader code (`TuiConfig.loadState` → `resolvePluginSpec` →
`plugin_origins` → `loadExternal(kind:"tui")`) is minified; the current working
hypothesis is that `resolvePluginSpec` yields nothing for a locally-present,
non-registry spec so `plugin_origins` ends up empty and no load is attempted —
unconfirmed, and not resolvable from the outside without deeper reverse
engineering or an upstream fix.

## Implication for the kata

The kata's mandated vehicle (TUI plugin command with live apply) cannot be
verified to load on the pinned OpenCode. This is a spike *result*, not a spike
gap: the loading path is real but the package contract alone does not make it
load here.

## Options

- **A. Timeboxed deeper loader diagnosis** (inspect `resolvePluginSpec` /
  plugin state store; try the in-TUI plugin-manager install→add path). Unknown
  payoff; likely upstream-bug territory.
- **B. Ship typed + unit-tested, documented caveat.** Implement `exports["./tui"]`
  + `{ id, tui }` against `@opencode-ai/plugin` types, unit-test the
  write→apply logic, document `tui.json` packaging and a manual smoke step;
  record that live load was unverifiable. Violates the kata's spike-first gate
  in spirit.
- **C. Defer the kata**, recording these findings on it; revisit when upstream
  TUI-plugin loading is stable/documented.
