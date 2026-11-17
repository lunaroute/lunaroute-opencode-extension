# zarw — `/lunaroute project`: a repo-persisted project ID on every LunaRoute request

2026-11-17 · kata `zarw` · branch `zarw-project-id-attribution` · port of pi `ga6g` (v0.19.0)

## Intent

LunaRoute splits its usage ledger by *project*: an optional free-form label
(≤128 chars) sent per request as the `LUNAROUTE-PROJECT-ID` header. Projects
change no auth, routing or concurrency — they only make usage readable per app,
environment or team.

This extension tags every request with `lunaroute-agent`,
`x-lunaroute-session` and `lunaroute-session-id` and nothing else
(`buildAttributionHeaders`, `src/lunaroute.ts:16`), so every OpenCode session on
a machine lands in one usage bucket. The user wants to declare "this repo is
`lunaroute-web`" once, in the repo, and have every request from that repo carry
it — including for a teammate who clones it.

pi already does this (`ga6g`): `<git root>/.lunaroute.json` holding
`{"project": "<name>"}`, read tolerantly, written atomically, injected as a
literal request header. This is the same feature for OpenCode, sharing the same
file and header so both agents attribute a repo identically. Read pi's
`src/project.ts` (185 lines) and its design as the reference; this document
records only what differs and the decisions made here.

## Goals

- `/lunaroute project <name>` writes the project for the current location into
  that repository.
- Bare `/lunaroute project` shows the effective value, the file it came from,
  and offers a name to edit (current value, else the folder name).
- `/lunaroute project clear` (also `off`) removes it.
- Model requests, hosted-MCP registration, and the first-class tools
  (`web_search`/`web_fetch`, image, convert) carry the header.
- A repo with no project file sends today's headers byte-for-byte.
- A hand edit to `.lunaroute.json` takes effect on the next model request and
  the next tool call, with no restart — that is the headless story
  (README:197: no TUI, the file is the interface).

## Non-goals

- `LUNAROUTE_PROJECT_ID` env override — conflicts with "no file ⇒ unchanged"
  and makes `project clear` not clear the effective value. Its own kata.
- Server-side project management (create/list/rename), org defaults, per-model
  or per-provider project.
- Tagging the model-catalog fetch (`src/models.ts:24`) or the `tools/list`
  probe (`listServerToolDescriptors`, `src/web-tools.ts:393`): both are
  metadata, not usage, and keep their current attribution headers. This is
  pi's classifier non-goal, same call.

## Anti-goals

- A project value that can expand into something else: not `{env:VAR}`, not
  `{file:path}`, not a shell exec, never in provider or model config.

## Constraints (verified in this repo, not assumed)

- **Setup is per-location.** The server plugin context carries
  `location: Location.Info` = `{ directory, workspaceID?, project: { id,
  directory, canonical } }` (`@opencode/plugin` `dist/promise/plugin.d.ts`), and
  setup re-runs on `location.reload()`. There is no process-global session
  state to capture — pi's `setSessionRoot`/`readSessionProject` and its
  "no header before session_start" gap do not port.
- **The TUI half has less information.** Its context carries
  `location: LocationRef | undefined` = `{ directory, workspaceID? }` only
  (`@opencode/client` `promise/generated/types.d.ts`) — no project field — and
  may be `undefined`.
- **The three tagging seams differ in lifetime.** `model.request` gives mutable
  per-request `event.headers`, already scoped to our provider
  (`src/index.ts:110-114`). First-class tools build headers per call
  (`src/web-tools.ts:434`, `src/image-tools.ts:632`, `src/convert-tools.ts:555`).
  MCP server headers are static registry state baked inside a transform
  (`src/mcp.ts:61`); the host owns the client afterwards, so no per-request
  seam exists and the TUI's only lever is `client.location.reload()`
  (`src/tui.ts:93`, the settings precedent). A server-side RPC exists
  (`ctx.rpc.register`) but this repo registers none, and reload is already the
  live-apply path.
- **The file is untrusted input.** It arrives with a clone; a hostile one must
  only ever be able to mislabel reporting.
- **Header limits:** 128 characters, printable ASCII (CR/LF is header
  injection; non-ASCII is silently mangled on the wire).
- **No startup surface for a warning.** Plugin `console.*` output is not
  captured in OpenCode 2.0.x, so visibility cannot rely on a log line.
- **Packaging:** `files: ["src", …]` — a new `src/project.ts` ships as-is.

## Approaches

- **A — repo-local `<root>/.lunaroute.json`, literal request headers (chosen).**
  One line of committed config per repo; a team shares one label; per-repo
  attribution survives switching checkouts. Costs a second config file and a
  per-request (few-stat) root walk and file read.
- **B — a key in the global settings file** (`~/.local/share/opencode/lunaroute.json`).
  Cheapest — the tolerant read, atomic write and live-apply machinery already
  exist — but the label is per app/environment/team: a teammate cannot inherit
  it, and moving between repos means editing one machine-global value by hand.
- **C — env var only.** Nothing persists per repo, and an invisible variable is
  not something a user remembers to export.
- Also considered and dropped: tagging model requests only. Cheaper, but every
  hosted-MCP tool call and every first-class tool call would still report to the
  default bucket, so the ledger splits by *how* the request was made — the
  opposite of the point.

## Design

### 1. Storage — `src/project.ts` (new), ported from pi

- `findProjectRoot(directory)`: nearest ancestor holding a `.git` entry
  (`existsSync` — worktrees and submodules have a `.git` *file*), else
  `directory`. The **one** resolver, called with `ctx.location.directory` on the
  server side and `context.location?.directory` in the TUI. Both sides resolve
  the same root because they run the same function on the same directory; no
  branch on `location.project.directory` (unverified semantics, and the TUI has
  no such field — two resolvers that disagree would silently write one file and
  read another).
- File `<root>/.lunaroute.json`, `{"project": "<name>"}`.
- `readProject(root, io)`: tolerant — missing file, unreadable file, bad JSON,
  wrong shape, invalid name ⇒ `undefined`, never throws. Bounded read: 4096
  bytes, `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, one `fstat`, one bounded `read`,
  strict UTF-8 decode (lenient decoding can turn undecodable bytes into a valid
  JSON string). Keep pi's `readFileBytes ? … : readFileSync` fallback so the io
  fake stays small.
- `writeProject` / `clearProject`: tmp + rename, temp unlinked if write or
  rename fails. Failures propagate — a read-only checkout is reported, never
  swallowed as success.
- `validateProjectName(raw)`: trim; 1..128 printable ASCII; reject the reserved
  command words `clear` and `off` (case-insensitive) so a project can be
  addressed again once set; reject `{` and `}` (OpenCode's config substitution
  delimiters — see Trust model). pi's `$` rejection is **not** copied: it
  guarded pi's own `$VAR` expansion, which does not exist here.
- `projectHeaders(project)`: `{}` when unset or invalid, so spreading it leaves
  an unset request byte-identical to today; otherwise the literal pair.
- Injectable io seam, same shape/spirit as `SettingsIo` (`src/settings.ts:55`) —
  not `readSettings`/`writeSettings`, which are bound to the settings file.
- No cache in v1: the walk is a few stats and the read is bounded. The read is
  what makes a hand-edited file live; do not optimize it away without replacing
  that property.

### 2. Tagging — literal headers, three seams

- **Model requests:** the existing provider-scoped `model.request` hook merges
  `projectHeaders(readProject(projectRoot))` next to `buildAttributionHeaders`.
  When set, remove any case-insensitive `LUNAROUTE-PROJECT-ID` already in
  `event.headers` first, so exactly one spelling reaches the wire.
- **MCP registration:** `buildMcpServer` takes the project; the project is read
  inside the transform so a re-transform picks up a change.
- **First-class tools:** extend each per-call `headers(key)` helper.
- **Asymmetric propagation, by design and documented:** a hand edit reaches
  model requests and first-class tools on the next call; it reaches
  `mcp.lunaroute` only on the next transform or restart. The command's reload
  closes the MCP gap; nothing else needs one.
- **`model.request` covers titles/compaction/generate too** (the hook fires for
  all four kinds), so plugin-internal model traffic is attributed to the repo as
  well. That matches "every request from that repo"; noted so it is not read as
  a bug later.

### 3. Command surface — TUI only, no login required

In `src/tui.ts`, beside the settings rows:

- Slash form: add `arguments: true` to the existing `/lunaroute` slash entry and
  parse `run(input)`: `project <name>` sets, `project clear|off` clears, bare
  `project` opens the prompt. Anything else falls through to today's menu.
- Bare `/lunaroute project`: `ui.dialog.prompt({ value: current ?? folderName })`
  (a placeholder carries the other candidate), then report the effective value
  **and** the file path. Cancel writes nothing.
- A `Project — <current | (none)>` row in the `/lunaroute` menu that opens the
  same prompt. This is the visibility counterweight: a committed label takes
  effect for anyone who clones the repo, and with no captured console output the
  menu row is the default place it can be seen.
- `context.location === undefined` ⇒ error toast ("cannot determine the
  repository"), never a guess. A write failure ⇒ error toast with the reason.
  Success ⇒ toast the file path, then `location.reload()`.
- No "unknown option" message exists here today (`src/tui.ts` is a pure select
  dialog) — the parse and its error toast are new code.
- Headless: unchanged story — the file is the interface (README:197).

### 4. Trust model

A committed `.lunaroute.json` takes effect automatically for anyone who checks
that repo out. That is the feature — a team shares one label by committing it —
not something to gate: the worst a hostile file can do is mislabel reporting,
because the value is validated printable ASCII and only ever lands in literal
request headers.

The one exception is the MCP registration seam: that value does reach *host
config state* (`editor.set`, `src/mcp.ts:65`), and OpenCode config substitutes
`{env:VAR}` and `{file:path}`. Whether the host interpolates plugin-supplied
registry values is unverified, so a name containing `{` or `}` is rejected — a
label does not need them, and the rejection makes the answer not matter. Owned
consequence: a name pi accepts but this rejects reads as no-project here; one
README line says so.

Counterweight to the automatic effect is visibility, per §3.

### 5. Tests, docs

- `tests/project.test.ts`, injected fs and directory, no real repo or `$HOME`
  (temp-dir / fake-io style of `tests/settings.test.ts`): root discovery
  (`.git` directory and file), tolerant read, atomic-write failure paths,
  validation (empty, oversize, newline, non-ASCII, `{`/`}`), `projectHeaders`.
- Existing suites: the replayed `model.request` header (`tests/entry.test.ts`
  fake-event pattern), MCP transform before/after a change, tool-call headers,
  no-file ⇒ headers byte-identical to today, and the three command forms plus
  the `location: undefined` path (`tests/tui.test.ts` fake context needs
  `run(input)` and a `dialog.prompt` fake).
- `npm run check` (typecheck + vitest).
- README: one line under attribution, mirroring pi's. `docs/smoke-checklist.md`:
  `LUNAROUTE-PROJECT-ID` present on gateway and MCP logs when the file exists,
  absent otherwise.

## Live checks before merging (cheap, not covered by types)

1. `location.directory` is the launch directory, not a canonicalized parent:
   start OpenCode in a subdirectory of a git repo and confirm the header carries
   the repo-root file's value.
2. Bare `/lunaroute` + Enter still opens the settings dialog after
   `slash.arguments: true` lands ("keeps the slash command in the prompt").
3. `openSync` with `O_NOFOLLOW|O_NONBLOCK` behaves under the host runtime (pi's
   `readFileBytes` fallback is the escape hatch if not).

## Left to the builder

- Wording of the toasts and the post-write hint.
- Whether the host interpolates plugin-set MCP header values; record it if you
  find out (the brace rejection makes it non-blocking).
- Whether an io cache (path + mtime) is warranted; start without one.

## References

- pi: `lunaroute-pi-extension/src/project.ts`, `docs/superpowers/specs/2026-11-13-ga6g-project-id-design.md`.
- Host types: `@opencode/plugin` `dist/promise/plugin.d.ts`, `dist/promise/session.d.ts`, `dist/tui/context.d.ts`; `@opencode/schema` `dist/location.d.ts`.
- This repo: `src/index.ts`, `src/mcp.ts`, `src/tui.ts`, `src/settings.ts`, `README.md:179-201`.
