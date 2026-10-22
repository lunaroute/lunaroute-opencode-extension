# Catalog Fetch Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A location whose model-catalog fetch fails retries once, and if it still fails it registers one labeled placeholder that names the remedy — never a silently empty model list.

**Architecture:** The retry lives inside `fetchCatalog` (one place, injectable sleep, hardcoded budget). The placeholder is a plain `MappedModel` builder in `src/lunaroute.ts`, applied by `provider.load()` on every failure path that leaves no usable models, skipped by `defaultModelId()`, and excluded from the TUI's Refresh count.

**Tech Stack:** TypeScript, vitest, `@opencode/plugin` 2.0.29 (v2 provider transform API).

**Spec:** `docs/superpowers/specs/2026-10-22-catalog-fetch-failure-design.md`

## Global Constraints

- Retry: **2 attempts, 1000 ms apart**, 5 s timeout per attempt; retry transport errors, 5xx and 429; **never** retry 4xx or a body that fails to parse. Attempts/delay are constants — only `sleep` is injectable.
- Placeholder id: `login` (v1 id, kata 3xsy). Failure name: `Couldn't load models — run /lunaroute → Refresh models`. Logged-out name: `Log in with /connect`. Limits: `DEFAULT_CONTEXT_LIMIT` / `DEFAULT_OUTPUT_LIMIT`.
- A successful fetch replaces the placeholder; a failed **refresh** keeps the last good catalog (existing behaviour).
- No persisted catalog, no background retry, no new dependencies. `npm run check` (typecheck + vitest) stays green.

## Review Focus

- Gateway answers 200 with an HTML body (captive portal): `res.json()` rejects, so it must be `malformed catalog body` with **one** attempt — not mistaken for a transport throw. Pinned in Task 1.
- Revoked key (401): one attempt, then the failure placeholder. Its text advises a refresh, which is wrong there — README says `/connect` for that case (Task 5).
- Placeholder replacement: `editor.add` may be replace-by-provider or merge-by-id; unit tests cannot prove it. Live-verified in Task 6, with the explicit `editor.models.remove(...)` fallback only if merging is observed.
- OpenCode auto-picking the placeholder when no default model is set (TUI picker preselect, headless `opencode run`): no unit test can prove it. Live-verified in Task 6.
- Worst-case load cost: 2 × 5 s + 1 s = 11 s on a hung endpoint, and setup re-runs on every `location.reload()` and credential event. Accepted (fast-fail transients cost milliseconds); recorded as a Task 6 observation, not unit-tested.

---

### Task 1: Retrying catalog fetch

**Files:**
- Modify: `src/models.ts`
- Test: `tests/models.test.ts:19-21` (rewrite) plus a new `describe` block

**Interfaces:**
- Consumes: nothing new.
- Produces: `fetchCatalog(routingUrl, key, sessionId, opts)` where `opts` gains only
  `sleep?: (ms: number) => Promise<void>` (default: a `setTimeout` promise). Return type unchanged:
  `{ models, skipped } | { error: string }`, error carrying the **last** attempt's reason.

- [ ] **Step 1: Write the failing tests** — replace the existing `"returns error on !ok and on fetch failure"` in `tests/models.test.ts` with the transport-aware version, and append the retry block:

```ts
  it("returns error on !ok and on fetch failure", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    expect(await fetchCatalog("http://gw/v1", "lr_k", "sess-1", {
      fetch: vi.fn().mockResolvedValue({ ok: false, status: 401 }) as never, sleep,
    })).toEqual({ error: "HTTP 401" });
    const flaky = vi.fn().mockRejectedValue(new Error("boom"));
    expect(await fetchCatalog("http://gw/v1", "lr_k", "sess-1", { fetch: flaky as never, sleep }))
      .toEqual({ error: "boom" });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

describe("fetchCatalog retry", () => {
  it("retries once after a transport failure, then returns the catalog", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "m-1" }] }) });
    const sleep = vi.fn(async (_ms: number) => {});
    const r = await fetchCatalog("http://gw/v1", "lr_k", "s1", { fetch: fetchMock as never, sleep });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect("models" in r && r.models.map((m) => m.id)).toEqual(["m-1"]);
  });

  it("retries 5xx and 429, then gives up with the last status", async () => {
    const sleep = vi.fn(async () => {});
    const s503 = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    expect(await fetchCatalog("http://gw/v1", "lr_k", "s1", { fetch: s503 as never, sleep }))
      .toEqual({ error: "HTTP 503" });
    expect(s503).toHaveBeenCalledTimes(2);
    const s429 = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    expect(await fetchCatalog("http://gw/v1", "lr_k", "s1", { fetch: s429 as never, sleep }))
      .toEqual({ error: "HTTP 429" });
    expect(s429).toHaveBeenCalledTimes(2);
  });

  it("does not retry 4xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const sleep = vi.fn(async () => {});
    expect(await fetchCatalog("http://gw/v1", "lr_k", "s1", { fetch: fetchMock as never, sleep }))
      .toEqual({ error: "HTTP 401" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry a body that fails to parse", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError("Unexpected token <"); },
    });
    const sleep = vi.fn(async () => {});
    expect(await fetchCatalog("http://gw/v1", "lr_k", "s1", { fetch: fetchMock as never, sleep }))
      .toEqual({ error: "malformed catalog body" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/models.test.ts`
Expected: FAIL — one attempt only, `sleep` never called, parse error reported as the raw `Unexpected token <` message.

- [ ] **Step 3: Implement in `src/models.ts`**

Wrap the request in a 2-attempt loop with a 1000 ms `sleep` between attempts. Retry only when the attempt threw or answered `!res.ok` with `status >= 500 || status === 429`. Parse the body in its own `try`/`catch` and map a `json()` rejection to `{ error: "malformed catalog body" }`; a body that parses but is not `{ data: [...] }` keeps its existing message and is also not retried.

- [ ] **Step 4: Run the file and confirm green**

Run: `npx vitest run tests/models.test.ts`
Expected: PASS, and the file finishes in ~0 s (no real timers on any path).

- [ ] **Step 5: Commit**

```bash
git add src/models.ts tests/models.test.ts
git commit -m "fix(models): retry the catalog fetch once; never retry 4xx or an unparseable body (kata xn2w)"
```

---

### Task 2: Placeholder model and default-pick skip

**Files:**
- Modify: `src/lunaroute.ts`
- Test: `tests/lunaroute.test.ts`

**Interfaces:**
- Consumes: existing `MappedModel`, `DEFAULT_CONTEXT_LIMIT`, `DEFAULT_OUTPUT_LIMIT`, `defaultModelId`.
- Produces: `PLACEHOLDER_MODEL_ID = "login"`, `UNAVAILABLE_MODELS_NAME`, `LOGIN_PLACEHOLDER_NAME`,
  `placeholderModel(name: string): MappedModel`, and a `defaultModelId` that never returns `PLACEHOLDER_MODEL_ID`.

- [ ] **Step 1: Write the failing tests** — append to `tests/lunaroute.test.ts` (import the new names):

```ts
describe("placeholder model", () => {
  it("builds one labeled placeholder with the v1 id and the repo limit defaults", () => {
    const p = placeholderModel(UNAVAILABLE_MODELS_NAME);
    expect(p.id).toBe("login");
    expect(p.name).toBe("Couldn't load models — run /lunaroute → Refresh models");
    expect(p.tool_call).toBe(true);
    expect(p.reasoning).toBe(false);
    expect(p.limitContext).toBe(DEFAULT_CONTEXT_LIMIT);
    expect(p.limitOutput).toBe(DEFAULT_OUTPUT_LIMIT);
    expect(p.variants).toEqual({});
    expect(LOGIN_PLACEHOLDER_NAME).toBe("Log in with /connect");
  });

  it("defaultModelId never picks the placeholder", () => {
    const mk = (id: string): MappedModel => ({ id, name: id, reasoning: false, tool_call: true, attachment: false, limitContext: 1, limitOutput: 1, modalitiesInput: ["text"], variants: {} });
    expect(defaultModelId([placeholderModel(UNAVAILABLE_MODELS_NAME)])).toBeUndefined();
    expect(defaultModelId([placeholderModel(UNAVAILABLE_MODELS_NAME), mk("glm-5.3")])).toBe("glm-5.3");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/lunaroute.test.ts -t "placeholder model"`
Expected: FAIL — `placeholderModel` is not exported.

- [ ] **Step 3: Implement in `src/lunaroute.ts`**

`placeholderModel(name)` returns a `MappedModel` with id `login`, the given name, `reasoning: false`, `tool_call: true`, `attachment: false`, `limitContext: DEFAULT_CONTEXT_LIMIT`, `limitOutput: DEFAULT_OUTPUT_LIMIT`, `modalitiesInput: ["text"]`, `variants: {}`. `defaultModelId` filters out `PLACEHOLDER_MODEL_ID` before its existing preferred/lexicographic pick, keeping `undefined` for an empty or placeholder-only list.

- [ ] **Step 4: Run the file and confirm green**

Run: `npx vitest run tests/lunaroute.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lunaroute.ts tests/lunaroute.test.ts
git commit -m "feat(models): labeled placeholder for an unavailable catalog; default pick skips it (kata xn2w)"
```

---

### Task 3: Provider failure states

**Files:**
- Modify: `src/provider.ts`
- Test: `tests/provider.test.ts`, `tests/entry.test.ts:118-125`

**Interfaces:**
- Consumes: `placeholderModel`, `UNAVAILABLE_MODELS_NAME`, `LOGIN_PLACEHOLDER_NAME`, `PLACEHOLDER_MODEL_ID` from Task 2.
- Produces: no signature change; `register`/`refresh`/`getModels` behaviour changes only as described.

- [ ] **Step 1: Update the pinned tests and add the new ones** in `tests/provider.test.ts`

Import there: `import { LOGIN_PLACEHOLDER_NAME, UNAVAILABLE_MODELS_NAME } from "../src/lunaroute.js";`

Replace `"registers with zero models when logged out, without fetching"` with:

```ts
  it("registers the login placeholder when logged out, without fetching", async () => {
    const d = deps({ resolveKey: vi.fn(async () => undefined) });
    const provider = createLunarouteProvider(d);
    const { ctx, added } = makeCtx();
    await provider.register(ctx);

    expect(d.fetchCatalog).not.toHaveBeenCalled();
    expect(added[0].models.map((m) => m.id)).toEqual(["login"]);
    expect(added[0].models.map((m) => (m as { name?: string }).name)).toEqual([LOGIN_PLACEHOLDER_NAME]);
  });
```

Replace `"starts with zero models and warns when the catalog fetch fails"` with:

```ts
  it("registers the failure placeholder and warns when the catalog fetch fails", async () => {
    const d = deps({ fetchCatalog: vi.fn(async (): Promise<CatalogResult> => ({ error: "HTTP 401" })) });
    const provider = createLunarouteProvider(d);
    const { ctx, added } = makeCtx();
    await provider.register(ctx);

    expect(added[0].models.map((m) => (m as { name?: string }).name)).toEqual([UNAVAILABLE_MODELS_NAME]);
    expect(d.log).toHaveBeenCalledWith("warn", expect.stringContaining("catalog fetch failed: HTTP 401"));
  });
```

Add:

```ts
  it("registers the login placeholder when the credential lookup throws", async () => {
    const d = deps({ resolveKey: vi.fn(async () => { throw new Error("store unavailable"); }) });
    const provider = createLunarouteProvider(d);
    const { ctx, added } = makeCtx();
    await provider.register(ctx);

    expect(added[0].models.map((m) => (m as { name?: string }).name)).toEqual([LOGIN_PLACEHOLDER_NAME]);
    expect(d.log).toHaveBeenCalledWith("warn", expect.stringContaining("store unavailable"));
  });

  it("registers the failure placeholder when the catalog maps to zero models", async () => {
    const d = deps({ fetchCatalog: vi.fn(async (): Promise<CatalogResult> => ({ models: [], skipped: [{ id: "embed-x", reason: "non_chat_capability (embeddings)" }] })) });
    const provider = createLunarouteProvider(d);
    const { ctx, added } = makeCtx();
    await provider.register(ctx);

    expect(added[0].models.map((m) => (m as { name?: string }).name)).toEqual([UNAVAILABLE_MODELS_NAME]);
  });

  it("replaces the placeholder with the real catalog once a fetch succeeds", async () => {
    let result: CatalogResult = { error: "HTTP 500" };
    const d = deps({ fetchCatalog: vi.fn(async () => result) });
    const provider = createLunarouteProvider(d);
    const { ctx, added } = makeCtx();
    await provider.register(ctx);
    expect(provider.getModels().map((m) => m.id)).toEqual(["login"]);

    result = { models: [mapped], skipped: [] };
    await provider.refresh(ctx);

    expect(provider.getModels().map((m) => m.id)).toEqual(["glm-5.3"]);
    expect(added[added.length - 1].models.map((m) => m.id)).toEqual(["glm-5.3"]);
  });

  it("stays on the placeholder when a refresh also fails before any catalog loaded", async () => {
    const d = deps({ fetchCatalog: vi.fn(async (): Promise<CatalogResult> => ({ error: "HTTP 500" })) });
    const provider = createLunarouteProvider(d);
    const { ctx } = makeCtx();
    await provider.register(ctx);
    await provider.refresh(ctx);

    expect(provider.getModels().map((m) => m.id)).toEqual(["login"]);
  });
```

- [ ] **Step 2: Update the entry test** — in `tests/entry.test.ts`, replace the comment and assertion at `:118`/`:125`:

```ts
    // provider: stub + the logged-out placeholder (kata xn2w)
    ...
    expect(providerAdded[0].models.map((m) => (m as { id?: string }).id)).toEqual(["login"]);
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run tests/provider.test.ts tests/entry.test.ts`
Expected: FAIL on the placeholder assertions (`models` is `[]`).

- [ ] **Step 4: Implement in `src/provider.ts`**

In `load()`: credential lookup throws -> warn, then the login placeholder under the "no usable model loaded" rule. Missing credential -> `models = [placeholderModel(LOGIN_PLACEHOLDER_NAME)]`, still no fetch. Fetch error -> warn with the reason, then the failure placeholder **only if no usable model is already loaded** (a loaded catalog is kept, keeping the existing "refresh keeps the last good catalog" test green). Successful fetch -> `models = result.models.length > 0 ? result.models : [placeholderModel(UNAVAILABLE_MODELS_NAME)]`. "Usable" = at least one model whose id is not `PLACEHOLDER_MODEL_ID`.

- [ ] **Step 5: Run both files and confirm green**

Run: `npx vitest run tests/provider.test.ts tests/entry.test.ts`
Expected: PASS, including the untouched `"refresh keeps the last good catalog on a failed fetch"`.

- [ ] **Step 6: Commit**

```bash
git add src/provider.ts tests/provider.test.ts tests/entry.test.ts
git commit -m "fix(provider): never register an empty catalog — labeled placeholder instead (kata xn2w)"
```

---

### Task 4: Truthful Refresh-models toast

**Files:**
- Modify: `src/tui.ts:103-113`
- Test: `tests/tui.test.ts` (fake list gains ids), new case

**Interfaces:**
- Consumes: `PLACEHOLDER_MODEL_ID` from Task 2.
- Produces: no exported change; the Refresh action reports a failure variant when only the placeholder is left.

- [ ] **Step 1: Write the failing test** — extend `fakeContext` in `tests/tui.test.ts` to take an optional model list (`[{ providerID: "lunaroute", id: "glm-5.3" }, …]` by default, keeping the existing two-lunaroute shape so `"refresh: reloads and reports the catalog size"` still expects `Models reloaded — 2 available`), then add:

```ts
  it("refresh: reports a failure when only the placeholder came back", async () => {
    const { context, commands, toasts } = fakeContext(() => "__refresh", [{ providerID: "lunaroute", id: "login" }]);
    await tui.setup(context as never);
    await commands[0].run();

    expect(toasts.at(-1)).toMatchObject({ variant: "error" });
    expect(String(toasts.at(-1)?.message)).toContain("Couldn't load");
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/tui.test.ts -t "only the placeholder"`
Expected: FAIL — success toast saying `Models reloaded — 1 available`.

- [ ] **Step 3: Implement in `src/tui.ts`**

Count only models whose `providerID === "lunaroute"` **and** `id !== PLACEHOLDER_MODEL_ID`. When that count is 0, show the error variant with `Models reloaded — LunaRoute still couldn't load the catalog`; otherwise keep the existing success message and count.

- [ ] **Step 4: Run the file and confirm green**

Run: `npx vitest run tests/tui.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui.ts tests/tui.test.ts
git commit -m "fix(tui): Refresh models reports a failed catalog instead of counting the placeholder (kata xn2w)"
```

---

### Task 5: Docs

**Files:**
- Modify: `README.md`, `docs/smoke-checklist.md`, `docs/superpowers/specs/2026-10-15-opencode-v2-plugin-api-port-design.md:39`

**Interfaces:** none.

- [ ] **Step 1: Correct the pre-login sentence** — `README.md:87`: replace "Before your first login, no LunaRoute models are listed." with "Before your first login, `/models` lists a single placeholder model (`Log in with /connect`) — the real catalog replaces it after `/connect`." Keep the rest of that paragraph.

- [ ] **Step 2: Add the troubleshooting entry** to the existing list:

```md
- **A session shows no LunaRoute models** (or only "Couldn't load models — run
  /lunaroute → Refresh models"): the catalog could not be fetched when that session's
  folder first loaded — the gateway was unreachable, or the key was rejected. The plugin
  retries once, then says so instead of listing nothing. Run `/lunaroute` →
  **Refresh models** (same as `opencode reload`) once you are online: it re-fetches without
  restarting. A revoked key needs `/connect` instead — a refresh cannot fix it.
```

- [ ] **Step 3: Add the smoke section** to `docs/smoke-checklist.md`, all rows unchecked until Task 6 records them:

```md
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
```

- [ ] **Step 4: Mark the old decision superseded** — under the v2 port spec's locked decision 3 ("No placeholder model."), append:

```md
   *Superseded 2026-10-22 by kata xn2w — see
   [2026-10-22-catalog-fetch-failure-design.md](./2026-10-22-catalog-fetch-failure-design.md):
   a zero-model provider is invisible in `/models`, so a labeled placeholder returns.*
```

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: typecheck clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/smoke-checklist.md docs/superpowers/specs/2026-10-15-opencode-v2-plugin-api-port-design.md
git commit -m "docs(xn2w): catalog-failure troubleshooting, smoke rows, superseded port decision"
```

---

### Task 6: Live verification on OpenCode 2.1.2

**Files:**
- Modify: `docs/smoke-checklist.md` (tick rows with what was observed)
- Possibly modify: `src/provider.ts` (only if placeholder replacement turns out to merge — see Step 4)

**Interfaces:** none.

Rig (already used for the kata's evidence; rebuild if `/tmp` was cleaned):
`/tmp/oc212-home/.opencode/bin/opencode` (v2.1.2, installed with `HOME=/tmp/oc212-home`),
sandbox `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME`, a global
`opencode.json` whose `plugins` entry is **this worktree's absolute path**, a `key`
credential row inserted into `<sandbox>/data/opencode/opencode.db` (`credential` table), and
the stub gateway `/tmp/lr-stub.py` on `127.0.0.1:4711` whose `/v1/models` answer flips via
`/tmp/lr-stub.mode` (`ok` | `fail`).

- [ ] **Step 1: Install deps in the worktree** (the plugin resolves them from here)

Run: `npm install --no-audit --no-fund`
Expected: `node_modules/@opencode/plugin` present.

- [ ] **Step 2: Failed catalog** — stub in `fail` mode, cold start, then check the model list

Run: `opencode models --standalone | grep -i lunaroute`
Expected: exactly `lunaroute/login`; `opencode serve` stdout shows
`LunaRoute: catalog fetch failed: HTTP 500`.

- [ ] **Step 3: Recovery replaces the placeholder** — flip the stub to `ok`, reload, list again

Run: `opencode reload --server <url>` then `opencode models --server <url> | grep -i lunaroute`
Expected: only the real catalog ids; `lunaroute/login` absent.

- [ ] **Step 4: If (and only if) Step 3 shows `lunaroute/login` beside real models**, OpenCode merges by id: add an explicit `editor.models.remove(LUNAROUTE_PROVIDER, PLACEHOLDER_MODEL_ID)` in `apply()` when a usable catalog exists, re-run Step 3, then

```bash
git add src/provider.ts
git commit -m "fix(provider): drop the placeholder explicitly when a catalog loads (kata xn2w)"
```

- [ ] **Step 5: No auto-pick of the placeholder** — with the stub failing and no default model set, run `opencode run "hi" --server <url>` and inspect which model it resolved.
Expected: it does **not** silently run `lunaroute/login` (record what it does; if it does, note the finding in the kata and pick a placeholder id that sorts last before closing).

- [ ] **Step 6: Logged out** — set the credential row `active=0`, cold start, list
Expected: exactly `lunaroute/login` named `Log in with /connect`.

- [ ] **Step 7: Record the results** — tick the Task 5 smoke rows with the observed output and the opencode version, then

```bash
git add docs/smoke-checklist.md
git commit -m "docs(xn2w): record live catalog-failure verification on opencode 2.1.2"
```
