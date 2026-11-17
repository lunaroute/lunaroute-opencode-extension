# Repo-local Project ID Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every LunaRoute request from a repository carries that repository's committed project label as `LUNAROUTE-PROJECT-ID`, set once with `/lunaroute project <name>` and stored in `<root>/.lunaroute.json`.

**Architecture:** A new `src/project.ts` owns storage (root discovery, tolerant bounded read, atomic write, validation) and is the only place that knows the file format. Three seams spread its header: the provider-scoped `model.request` hook (per request), `buildMcpServer` (per transform), and the three per-call `headers(key)` helpers of the first-class tools. The TUI plugin writes the file and reloads only for the MCP seam.

**Tech Stack:** TypeScript, vitest, `@opencode/plugin` 2.0.29 (v2 plugin + TUI plugin APIs), Node `fs` (via an injectable io seam).

**Spec:** `docs/superpowers/specs/2026-11-17-zarw-project-id-design.md` (read it with this plan; it carries the rationale and the pi reference)

## Global Constraints

- File: `<root>/.lunaroute.json`, body `{"project": "<name>"}`; header `LUNAROUTE-PROJECT-ID`.
- `root` = one resolver, `findProjectRoot(directory)`, fed `ctx.location.directory` (server plugin) and `context.location?.directory` (TUI plugin). Never `location.project.directory`.
- Name rules: trimmed, 1..128 characters, printable ASCII only (`\x20-\x7e`), not `clear`/`off` (case-insensitive), no `{` or `}`. `$` and `!` are **allowed** (pi parity).
- No project file ⇒ request headers byte-identical to today: the header key is never added as `undefined` or `""`.
- Read bounded at 4096 bytes, `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, strict UTF-8; read never throws; write is tmp + rename with the tmp unlinked on failure; write failures surface to the caller.
- No new dependencies. `npm run check` (tsc + vitest) green at every commit.

## Review Focus

- A hostile or corrupt committed `.lunaroute.json` (oversized, undecodable bytes, JSON array, non-string `project`, newline in the name) must degrade to *no header*, never break a request — Task 1 (read/validation) and Task 2 (headers byte-identical when unset).
- The name `clear`/`off` — and any name with `{`/`}`, a newline, or >128 chars — must be refused at write time with a reason the user sees, not silently stored — Task 1 (validation) and Task 5 (toast).
- A request already carrying a differently-cased `lunaroute-project-id` must leave with exactly one spelling — Task 2.
- A repo with no `.git` ancestor: the label must apply only when OpenCode is launched in exactly the directory that holds the file (the walk-up looks for `.git`, not for `.lunaroute.json`) — Task 1 (resolver test) and Task 6 (README wording).
- A hand edit to the file while a session is live must reach the next model request and the next first-class tool call without a restart — Task 2 and Task 4 read per use; only Task 3's MCP seam waits for a transform.

---

### Task 1: `src/project.ts` — storage, root discovery, validation

**Files:**
- Create: `src/project.ts`
- Test: `tests/project.test.ts`

**Interfaces:**
- Consumes: `SettingsIo` from `src/settings.ts:55` (shape only: `readFileSync`, `writeFileSync`, `renameSync`, `randomUUID`).
- Produces (every later task uses these exact names):
  - `PROJECT_FILE = ".lunaroute.json"`, `PROJECT_HEADER = "LUNAROUTE-PROJECT-ID"`, `MAX_PROJECT_FILE_BYTES = 4096`
  - `interface ProjectIo extends SettingsIo { existsSync(path: string): boolean; readFileBytes?(path: string): Uint8Array; unlinkSync?(path: string): void }`, `defaultProjectIo: ProjectIo`
  - `findProjectRoot(directory: string, io?: ProjectIo): string`
  - `projectFilePath(root: string): string`
  - `validateProjectName(raw: string): { ok: true; name: string } | { ok: false; reason: string }`
  - `readProject(root: string, io?: ProjectIo): string | undefined`
  - `writeProject(root: string, name: string, io?: ProjectIo): void` — throws on invalid name or io failure
  - `clearProject(root: string, io?: ProjectIo): void` — writes `{}`
  - `projectHeaders(project: string | undefined): Record<string, string>` — `{}` unless the name validates

- [ ] **Step 1: Write the failing tests** in `tests/project.test.ts`. Use real `mkdtemp` dirs only for `findProjectRoot`; everything else uses recording fakes (mirror `tests/settings.test.ts`'s `ioRecording`):

```ts
const ENC = new TextEncoder();
const fakeIo = (over: Partial<ProjectIo> = {}): ProjectIo => ({
  readFileSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
  writeFileSync: () => {}, renameSync: () => {}, randomUUID: () => "uuid-1",
  existsSync: () => true, unlinkSync: () => {}, ...over,
});
const bytesIo = (raw: string) => fakeIo({ readFileBytes: () => ENC.encode(raw) });

// findProjectRoot
it("stops at the nearest ancestor with a .git directory", ...)      // root/.git dir, session root/a/b → root
it("treats .git as a file (worktrees, submodules)", ...)            // root/.git file → root
it("falls back to the given directory when no .git exists", ...)    // root/a/b, no .git anywhere → root/a/b

// readProject — every failure mode is undefined, never a throw
it.each([
  ["missing file", fakeIo()],
  ["bad JSON", bytesIo("{not json")],
  ["json array", bytesIo("[]")],
  ["non-string project", bytesIo('{"project":42}')],
  ["missing project key", bytesIo("{}")],
  ["newline in name", bytesIo('{"project":"a\\nb"}')],
  ["braces in name", bytesIo('{"project":"{file:/etc/passwd}"}')],
  ["oversize file", bytesIo(`{"project":"${"a".repeat(4100)}"}`)],
  ["undecodable bytes", fakeIo({ readFileBytes: () => new Uint8Array([0x7b, 0xff, 0x7d]) })],
])("readProject → undefined for %s", (_label, io) => expect(readProject("/r", io)).toBeUndefined());

it("returns a valid name, trimmed", () => expect(readProject("/r", bytesIo('{"project":" lunaroute-web "}'))).toBe("lunaroute-web"));

// validateProjectName
it.each([
  ["", false], ["   ", false], ["a".repeat(128), true], ["a".repeat(129), false],
  ["a\nb", false], ["héllo", false], ["clear", false], ["CLEAR", false], ["off", false],
  ["{x}", false], ["x}", false], ["my app", true], ["$HOME", true], ["!cmd", true],
])("validateProjectName(%j) → ok=%s", (raw, ok) => expect(validateProjectName(raw).ok).toBe(ok));

// writeProject / clearProject
it("writes tmp then renames to <root>/.lunaroute.json", ...)         // writes[0].path ends ".lunaroute.json.uuid-1.tmp", data '{"project":"web"}\n', renames[0] = [tmp, "/r/.lunaroute.json"]
it("validates before writing", ...)                                  // writeProject("/r","clear",rec) throws; rec.writes empty
it("unlinks the tmp and rethrows when rename fails", ...)            // renameSync throws → unlinkSync called with tmp → error propagates
it("clearProject writes an empty object", ...)                       // data "{}\n"

// projectHeaders
it("is empty without a project or with an invalid one", ...)         // undefined, "clear", "a\nb" → {}
it("emits the literal pair", ...)                                    // "lunaroute-web" → { "LUNAROUTE-PROJECT-ID": "lunaroute-web" }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/project.test.ts`
Expected: FAIL — `Cannot find module '../src/project.js'`.

- [ ] **Step 3: Implement `src/project.ts`**

Port pi's `src/project.ts` structure (bounded `readProjectBytes`, `RESERVED_NAMES`, tmp+rename) with two deliberate differences: `validateProjectName` also rejects `{`/`}` (reason: `` `{` and `}` are not valid in a project name. ``), and there is no `setSessionRoot`/`readSessionProject` module state. `readProject` uses `io.readFileBytes` when present (strict `new TextDecoder("utf-8", { fatal: true })`) and otherwise `io.readFileSync(path)` followed by the same `MAX_PROJECT_FILE_BYTES` length check. Keep the file to storage only — no `fs` import outside `defaultProjectIo`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/project.test.ts` then `npm run typecheck`
Expected: all tests PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/project.ts tests/project.test.ts
git commit -m "feat(zarw): repo-local project file, validation, header helper"
```

---

### Task 2: Model-request header (and the root the other tasks reuse)

**Files:**
- Modify: `src/index.ts` (setup: capture the root; the `model.request` hook at `src/index.ts:108-115`)
- Test: `tests/entry.test.ts` (the fake `ctx` gains `location`; extend the attribution assertions at `tests/entry.test.ts:127-137`)

**Interfaces:**
- Consumes: Task 1's `findProjectRoot`, `readProject`, `projectHeaders`, `PROJECT_HEADER`.
- Produces: nothing new for other tasks — but `tests/entry.test.ts`'s `makeCtx(auth?, directory?)` now takes a directory, which Tasks 3 and 4 reuse if they touch the entry fake.

- [ ] **Step 1: Write the failing tests** — add `location: { directory }` to the fake `ctx` in `makeCtx`, then extend the attribution test:

```ts
    // no project file: headers are exactly today's
    const plain = { headers: {} as Record<string, string> };
    hooks[0].cb(plain);
    expect(Object.keys(plain.headers).sort()).toEqual(["lunaroute-agent", "lunaroute-session-id", "x-lunaroute-session"]);

    // a project file written after setup is read per request (hand edits live)
    writeFileSync(join(directory, ".lunaroute.json"), '{"project":"lunaroute-web"}\n');
    const withProject = { headers: {} as Record<string, string> };
    hooks[0].cb(withProject);
    expect(withProject.headers["LUNAROUTE-PROJECT-ID"]).toBe("lunaroute-web");
    expect(withProject.headers["lunaroute-agent"]).toBe("opencode");

    // a differently-cased header already present leaves one spelling only
    const cased = { headers: { "lunaroute-project-id": "stale" } as Record<string, string> };
    hooks[0].cb(cased);
    expect(cased.headers["LUNAROUTE-PROJECT-ID"]).toBe("lunaroute-web");
    expect(Object.keys(cased.headers).filter((k) => k.toLowerCase() === "lunaroute-project-id")).toHaveLength(1);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/entry.test.ts`
Expected: FAIL — `LUNAROUTE-PROJECT-ID` undefined.

- [ ] **Step 3: Implement** in `src/index.ts`: in `setup`, `const projectRoot = findProjectRoot(ctx.location.directory);`; inside the existing hook callback, before `Object.assign`, delete every existing key whose lowercase form is `lunaroute-project-id`, then merge `projectHeaders(readProject(projectRoot))` after `buildAttributionHeaders(sessionId)`. Nothing else changes — no provider config, no new hook.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/entry.test.ts && npm run check`
Expected: PASS; whole suite green.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/entry.test.ts
git commit -m "feat(zarw): project header on model requests, root captured at setup"
```

---

### Task 3: Hosted-MCP registration header

**Files:**
- Modify: `src/mcp.ts` (`buildMcpServer` at `:61`, `createLunarouteMcp` opts), `src/index.ts` (pass the getter)
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Consumes: Task 1's `readProject`, `projectHeaders` (in `src/index.ts` only).
- Produces: `buildMcpServer(key: string, mcpUrl: string, sessionId: string, project?: string): McpServerLike`; `createLunarouteMcp` opts gain `project?: () => string | undefined`, called inside the transform.

- [ ] **Step 1: Write the failing tests** in `tests/mcp.test.ts`:

```ts
  it("tags the registered server with the project read at transform time", async () => {
    let current: string | undefined = "lunaroute-web";
    const { ctx, setCalls, reload } = makeCtx();
    const mcp = createLunarouteMcp({ ...opts(), project: () => current });
    await mcp.register(ctx, "lr_key");
    expect(setCalls[0].config.headers["LUNAROUTE-PROJECT-ID"]).toBe("lunaroute-web");
    current = "lunaroute-api";
    await reload();                                   // a re-transform picks up the change
    expect(setCalls.at(-1)?.config.headers["LUNAROUTE-PROJECT-ID"]).toBe("lunaroute-api");
  });

  it("omits the header entirely when no project is set", async () => {
    const { ctx, setCalls } = makeCtx();
    await createLunarouteMcp({ ...opts(), project: () => undefined }).register(ctx, "lr_key");
    expect("LUNAROUTE-PROJECT-ID" in setCalls[0].config.headers).toBe(false);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mcp.test.ts`
Expected: FAIL — unknown `project` option / missing header.

- [ ] **Step 3: Implement**: `buildMcpServer` spreads `projectHeaders(project)` after `buildAttributionHeaders(sessionId)`; `createLunarouteMcp` stores `opts.project` and its `apply` passes `isProject?.()` into `buildMcpServer` (evaluated inside the transform, so `mcp.reload()` re-reads). In `src/index.ts`, pass `project: () => readProject(projectRoot)`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mcp.test.ts && npm run check`

- [ ] **Step 5: Commit**

```bash
git add src/mcp.ts src/index.ts tests/mcp.test.ts
git commit -m "feat(zarw): project header on hosted-MCP registration"
```

---

### Task 4: First-class tool headers (`web`, `image`, `convert`)

**Files:**
- Modify: `src/web-tools.ts` (`WebToolMapDeps`, `headers(key)` at `:434`), `src/image-tools.ts` (`:632`), `src/convert-tools.ts` (`:555`), `src/index.ts` (pass the getter to all three builders)
- Test: one case in each of `tests/web-tools.test.ts`, `tests/image-tools.test.ts`, `tests/convert-tools.test.ts`

**Interfaces:**
- Consumes: Task 1's `projectHeaders`, `readProject`.
- Produces: each of the three `*ToolMapDeps` gains `readProject?: () => string | undefined` (optional): absent ⇒ today's headers, so existing tests keep their fixtures unchanged.

- [ ] **Step 1: Write the failing tests** — in each suite, run one successful tool call twice against the existing fake server: once with `readProject: () => "lunaroute-web"` and assert `recorded[0].headers["LUNAROUTE-PROJECT-ID"] === "lunaroute-web"`, once with `readProject: () => undefined` (and once with the dep omitted) and assert the key is absent (`"LUNAROUTE-PROJECT-ID" in headers === false`).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/web-tools.test.ts tests/image-tools.test.ts tests/convert-tools.test.ts`
Expected: FAIL on the three new assertions.

- [ ] **Step 3: Implement**: in each module's `headers(key)` closure, spread `...projectHeaders(deps.readProject?.())` after `buildAttributionHeaders(deps.sessionId)`; in `src/index.ts` pass `readProject: () => readProject(projectRoot)` to `buildWebToolMap`, `buildImageToolMap`, `buildConvertToolMap`. Do not add the header to `listServerToolDescriptors` (the tools/list probe stays untagged, per spec §Non-goals).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/web-tools.test.ts tests/image-tools.test.ts tests/convert-tools.test.ts && npm run check`

- [ ] **Step 5: Commit**

```bash
git add src/web-tools.ts src/image-tools.ts src/convert-tools.ts src/index.ts tests/web-tools.test.ts tests/image-tools.test.ts tests/convert-tools.test.ts
git commit -m "feat(zarw): project header on first-class tool calls"
```

---

### Task 5: `/lunaroute project` command and the menu row

**Files:**
- Modify: `src/tui.ts` (command definition at `:37-53`, `open()` at `:66-78`)
- Test: `tests/tui.test.ts` (fake context gains `location` and a `prompt` fake; `Command.run` gains the `input` parameter)

**Interfaces:**
- Consumes: Task 1's whole module plus `node:fs` `existsSync` for the invalid-vs-missing distinction.
- Produces: nothing exported; the run signature becomes `run: (input?: string) => Promise<void>`.

- [ ] **Step 1: Write the failing tests** in `tests/tui.test.ts` — extend `fakeContext` with `location: { directory: join(dir, "repo") }`, `ui.dialog.prompt: async (opts) => promptResponder(opts)`, and `type Command = { id: string; slash: { name: string }; run: (input?: string) => Promise<void> }`. Create `<tmp>/repo/.git` (a directory) each test. Cases:

```ts
it("slash argument writes the file and reloads", ...)        // run("project lunaroute-web") → repo/.lunaroute.json data '{"project":"lunaroute-web"}\n', reload called, success toast names the path
it("bare project pre-fills the current value", ...)          // file has "lunaroute-web"; prompt opts.value === "lunaroute-web"; responder returns "lunaroute-api" → file rewritten
it("bare project pre-fills the folder name when unset", ...) // no file; opts.value === "repo"
it("cancel writes nothing", ...)                             // prompts returns undefined → no file, no reload
it("clear empties an existing file", ...)                    // run("project clear") → data "{}\n", reload
it("clear with no file writes nothing", ...)                 // run("project off") → repo/.lunaroute.json still absent, info toast
it("invalid name toasts the reason and writes nothing", ...) // run("project clear") is reserved; use run("project {x}") and run(`project ${"a".repeat(129)}`)
it("no location toasts instead of guessing", ...)            // context.location = undefined → error toast, no write
it("menu row reports the effective value", ...)              // file present → row description/value contains "lunaroute-web"
it("menu row distinguishes an invalid file", ...)            // file "{oops" → row shows "(invalid file at <path>)"
it("bare /lunaroute still opens the settings dialog", ...)   // run(undefined) → a select was shown, no prompt
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tui.test.ts`
Expected: FAIL — the command has no `run(input)` behavior and no prompt fake is used.

- [ ] **Step 3: Implement** in `src/tui.ts`:
  - `slash: { name: "lunaroute", arguments: true }`; `run: async (input) => { const arg = projectArg(input); if (arg === undefined) await open(context); else await project(context, arg); }`.
  - `projectArg(input)`: trim; drop a leading `/lunaroute` or `lunaroute` token; return the text after a leading `project` keyword (`""` for bare `project`), else `undefined`.
  - `project(context, arg)`: `const directory = context.location?.directory; if (!directory) → error toast "cannot determine the repository — open the command from a workspace folder"`, then `root = findProjectRoot(directory)`. `arg === ""` → prompt flow; `arg === "clear" || arg === "off"` → clear flow; else write flow.
  - Write flow: `writeProject(root, name)` in `try/catch`; on throw, error toast `Not saved: <message>`; on success, success toast `Project = <name> · <path>` then `client.location.reload()` in `try/catch` (toast `Saved, but reload failed: <message>` — mirroring `apply`).
  - Clear flow: `existsSync(projectFilePath(root))` false ⇒ info toast `No LunaRoute project set in <path>` and no write; else `clearProject` + same toast/reload.
  - Prompt flow: `value: readProject(root) ?? basename(root)` (fall back to `""` when the folder name fails `validateProjectName`), `placeholder` the other candidate, `description` the state: `(none)` when no file, `(invalid file at <path>)` when the file exists but does not read.
  - Menu: insert `{ title: "Project", value: PROJECT, description: <current value or (none)/(invalid file at <path>)> }` as the first option; selecting it runs the prompt flow.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tui.test.ts && npm run check`

- [ ] **Step 5: Commit**

```bash
git add src/tui.ts tests/tui.test.ts
git commit -m "feat(zarw): /lunaroute project command with a menu row"
```

---

### Task 6: README and smoke checklist

**Files:**
- Modify: `README.md` (attribution section, `:28-40`; TUI command section, `:179-201`)
- Modify: `docs/smoke-checklist.md`

**Interfaces:** none.

- [ ] **Step 1: README** — under attribution, add one short subsection: the header and its purpose, `/lunaroute project <name>` / `project clear`, the file path, that `/lunaroute project` with no name shows the effective value and the file, that the label applies only when OpenCode is launched in (or below a git root of) the directory holding the file, that a hand edit applies to model and first-class tool requests immediately while `mcp.lunaroute` follows on the next reload, and one line owning the divergence: names containing `{`/`}` are ignored by this extension (OpenCode config substitution delimiters) while pi accepts them.
- [ ] **Step 2: Smoke checklist** — one item: with `<repo>/.lunaroute.json` holding a label, a chat request and a hosted-MCP tool call show `LUNAROUTE-PROJECT-ID` with that value at the gateway/MCP; with the file removed, the header is absent.
- [ ] **Step 3: Verify and commit**

Run: `npm run check`
```bash
git add README.md docs/smoke-checklist.md
git commit -m "docs(zarw): document /lunaroute project and its smoke check"
```

---

### Task 7: Live checks (manual, blocks the merge)

**Files:** none — record results in the kata comment and the PR body.

- [ ] **Step 1: Root is the launch directory.** `cd <tmp>/repo && git init && mkdir sub && echo '{"project":"sub-check"}' > .lunaroute.json`, then launch OpenCode from `repo/sub`, send one message, and confirm the gateway received `LUNAROUTE-PROJECT-ID: sub-check` (the walk-up must find `repo/.git`). If `location.directory` turns out not to be the launch dir, stop and report — the whole design hangs on this one fact.
- [ ] **Step 2: Bare `/lunaroute` still opens the settings dialog** after `slash.arguments: true` (it "keeps the slash command in the prompt"). If it does not, fall back to `slash.arguments` absent plus a `/lunaroute-project` second command, and note the change in the spec.
- [ ] **Step 3: The bounded read works under the host runtime** — set a project, make one request, and confirm the header arrives (this exercises `openSync` with `O_NOFOLLOW|O_NONBLOCK` inside the plugin process). If it throws, switch `readProject` to the `readFileSync` fallback and re-run.
- [ ] **Step 4: Live-apply.** With a session open, run `/lunaroute project <name>` and confirm a following chat request carries the new value and the MCP entry list shows it after the reload.

---

## Self-review notes

- Spec §1 → Task 1; §2 → Tasks 2, 3, 4; §3 → Task 5; §4 (trust model) → Task 1 validation + Task 6 README; §5 (tests/docs) → inside Tasks 1-6; live checks → Task 7. Non-goals (catalog fetch, tools/list probe) are pinned as non-goals in Task 4's step 3.
- Task order is dependency order: 1 is required by 2-5; 2, 3 and 4 each ship independently green; 5 depends only on 1.
- Names are consistent across tasks: `findProjectRoot`, `readProject`, `projectHeaders`, `projectFilePath`, `PROJECT_HEADER`, `ProjectIo`.
