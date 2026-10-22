# Catalog Fetch Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A location whose model-catalog fetch fails retries briefly, and if it still fails it registers one labeled placeholder that names the remedy — never a silently empty model list.

**Architecture:** Retry lives inside `fetchCatalog` (one place, injectable sleep, no shared state). The placeholder is a plain `MappedModel` constant-builder in `src/lunaroute.ts`, applied by `provider.load()` on every failure path that leaves no usable models, and skipped by `defaultModelId()`.

**Tech Stack:** TypeScript, vitest, `@opencode/plugin` 2.0.29 (v2 provider transform API).

**Spec:** `docs/superpowers/specs/2026-10-22-catalog-fetch-failure-design.md`

## Global Constraints

- Retry: **3 attempts, 1000 ms apart**, 5 s timeout per attempt; retry transport errors, 5xx and 429; **never** retry 4xx or a malformed body.
- Placeholder id: `login` (v1 id, kata 3xsy). Failure name: `Couldn't load models — run /lunaroute → Refresh models`. Logged-out name: `Log in with /connect`.
- A successful fetch replaces the placeholder wholesale; a failed **refresh** keeps the last good catalog (existing behaviour).
- No persisted catalog, no background retry.
- No new dependencies. `npm run check` (typecheck + vitest) stays green.

## Review Focus

- Gateway answers with an empty `data` array (200) — user must get the failure placeholder, not an empty list. Pinned in Task 3.
- Revoked key (401) — must be a single attempt (no retry) and still end with a visible placeholder; the placeholder text advises refresh, which is wrong for a revoked key, so README must say `/connect` for that case. Pinned in Task 1 + Task 4.
- Worst-case load cost on a hung endpoint: 3 × 5 s + 2 s of waiting blocks that location's first load. Accepted (typical failures fail in ms); smoke-verified in Task 4, not unit-tested.
- Picking the placeholder and sending a prompt — must surface as an ordinary model error from the gateway, not a crash. Smoke row in Task 4 (no unit test: the gateway produces the error).
- Two locations loading concurrently each retry independently (no shared memo) — accepted, bounded by the retry budget, no test.

---

### Task 1: Retrying catalog fetch

**Files:**
- Modify: `src/models.ts`
- Test: `tests/models.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `fetchCatalog(routingUrl, key, sessionId, opts)` where `opts` gains
  `attempts?: number` (default 3), `delayMs?: number` (default 1000),
  `sleep?: (ms: number) => Promise<void>` (default `setTimeout` promise). Return type unchanged:
  `{ models, skipped } | { error: string }`, error carrying the **last** attempt's reason.

- [ ] **Step 1: Write the failing tests** — append to `tests/models.test.ts`:

```ts
describe("fetchCatalog retry", () => {
  it("retries transport failures and 5xx, then returns the catalog", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "m-1" }] }) });
    const sleep = vi.fn(async (_ms: number) => {});
    const r = await fetchCatalog("http://gw/v1", "lr_k", "s1", { fetch: fetchMock as never, sleep });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect("models" in r && r.models.map((m) => m.id)).toEqual(["m-1"]);
  });

  it("gives up after 3 attempts and reports the last error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const r = await fetchCatalog("http://gw/v1", "lr_k", "s1", { fetch: fetchMock as never, sleep: vi.fn(async () => {}) });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(r).toEqual({ error: "HTTP 500" });
  });

  it("does not retry 4xx or a malformed body", async () => {
    const unauthorized = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const sleep = vi.fn(async () => {});
    expect(await fetchCatalog("http://gw/v1", "lr_k", "s1", { fetch: unauthorized as never, sleep }))
      .toEqual({ error: "HTTP 401" });
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();

    const malformed = vi.fn().mockResolvedValue({ ok: true, json: async () => "<html>" });
    expect(await fetchCatalog("http://gw/v1", "lr_k", "s1", { fetch: malformed as never, sleep }))
      .toEqual({ error: "malformed catalog body" });
    expect(malformed).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/models.test.ts -t "fetchCatalog retry"`
Expected: FAIL — `fetchMock` called 1 time, `sleep` never called.

- [ ] **Step 3: Implement the retry loop in `src/models.ts`**

Extend the existing opts type and wrap the current single fetch in an attempt loop: retry when the attempt threw or answered `!res.ok` with `status >= 500 || status === 429`; return immediately otherwise, including the malformed-body path. `sleep` only between attempts.

- [ ] **Step 4: Run the whole file and confirm green**

Run: `npx vitest run tests/models.test.ts`
Expected: PASS (existing `fetchCatalog` tests included — they pass no `sleep`, so keep the default real timer out of their path: those cases succeed or fail in one attempt).

- [ ] **Step 5: Commit**

```bash
git add src/models.ts tests/models.test.ts
git commit -m "fix(models): retry the catalog fetch (3 attempts, no 4xx retry) (kata xn2w)"
```

---

### Task 2: Placeholder model constant and default-pick skip

**Files:**
- Modify: `src/lunaroute.ts`
- Test: `tests/lunaroute.test.ts`

**Interfaces:**
- Consumes: existing `MappedModel`, `defaultModelId`.
- Produces: `PLACEHOLDER_MODEL_ID = "login"`, `UNAVAILABLE_MODELS_NAME`, `LOGIN_PLACEHOLDER_NAME`,
  `placeholderModel(name: string): MappedModel`, and `defaultModelId` that never returns `PLACEHOLDER_MODEL_ID`.

- [ ] **Step 1: Write the failing tests** — append to `tests/lunaroute.test.ts` (import the new names):

```ts
describe("placeholder model", () => {
  it("builds one labeled placeholder with the v1 id", () => {
    const p = placeholderModel(UNAVAILABLE_MODELS_NAME);
    expect(p.id).toBe("login");
    expect(p.name).toBe("Couldn't load models — run /lunaroute → Refresh models");
    expect(p.tool_call).toBe(true);
    expect(p.reasoning).toBe(false);
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

`placeholderModel(name)` returns a `MappedModel` with id `login`, the given name, `reasoning: false`, `tool_call: true`, `attachment: false`, `limitContext: 128000`, `limitOutput: 8192`, `modalitiesInput: ["text"]`, `variants: {}`. `defaultModelId` filters out `PLACEHOLDER_MODEL_ID` before its existing preferred/lexicographic pick (keep `undefined` for an empty or placeholder-only list).

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
- Test: `tests/provider.test.ts`

**Interfaces:**
- Consumes: `placeholderModel`, `UNAVAILABLE_MODELS_NAME`, `LOGIN_PLACEHOLDER_NAME`, `PLACEHOLDER_MODEL_ID` from Task 2.
- Produces: no signature change; `register`/`refresh`/`getModels` behaviour changes only as described below.

- [ ] **Step 1: Update the two pinned tests and add three new ones** in `tests/provider.test.ts`

Import the Task 2 names there: `import { LOGIN_PLACEHOLDER_NAME, UNAVAILABLE_MODELS_NAME } from "../src/lunaroute.js";`

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

  it("stays on the placeholder when a refresh fails before any catalog loaded", async () => {
    const d = deps({ fetchCatalog: vi.fn(async (): Promise<CatalogResult> => ({ error: "HTTP 500" })) });
    const provider = createLunarouteProvider(d);
    const { ctx } = makeCtx();
    await provider.register(ctx);
    await provider.refresh(ctx);

    expect(provider.getModels().map((m) => m.id)).toEqual(["login"]);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/provider.test.ts`
Expected: FAIL on the placeholder assertions (`models` is `[]`).

- [ ] **Step 3: Implement in `src/provider.ts`**

In `load()`: missing credential -> `models = [placeholderModel(LOGIN_PLACEHOLDER_NAME)]` and return (still no fetch). Fetch error -> warn with the reason, then set the failure placeholder **only if no usable model is already loaded** (a loaded catalog is kept, so the existing "refresh keeps the last good catalog" test stays green). Successful fetch -> `models = result.models.length > 0 ? result.models : [placeholderModel(UNAVAILABLE_MODELS_NAME)]`. "Usable" means at least one model whose id is not `PLACEHOLDER_MODEL_ID`.

- [ ] **Step 4: Run the file and confirm green**

Run: `npx vitest run tests/provider.test.ts`
Expected: PASS, including the untouched `"refresh keeps the last good catalog on a failed fetch"`.

- [ ] **Step 5: Commit**

```bash
git add src/provider.ts tests/provider.test.ts
git commit -m "fix(provider): never register an empty catalog — labeled placeholder instead (kata xn2w)"
```

---

### Task 4: Docs and smoke rows

**Files:**
- Modify: `README.md` (Troubleshooting)
- Modify: `docs/smoke-checklist.md`

**Interfaces:** none.

- [ ] **Step 1: README troubleshooting entry** — add, in the existing Troubleshooting list:

```md
- **A session shows no LunaRoute models** (or only "Couldn't load models — run
  /lunaroute → Refresh models"): the catalog could not be fetched when that session's
  folder first loaded — the gateway was unreachable, or the key was rejected. The plugin
  retries three times, then says so instead of listing nothing. Run `/lunaroute` →
  **Refresh models** (same as `opencode reload`) once you are online: it re-fetches without
  restarting. A revoked key (`/connect` shows the account as failing) needs `/connect`,
  not a refresh.
```

- [ ] **Step 2: Smoke checklist rows** — add a section:

```md
## Catalog-fetch resilience (kata xn2w, verified 2026-10-22 on opencode 2.0.29 + 2.1.2)

- [x] **Gateway down at first load** -> exactly one `lunaroute/login` model named
  "Couldn't load models — run /lunaroute → Refresh models"; server stdout carries
  `LunaRoute: catalog fetch failed: …` (not `opencode.log`).
- [x] **Refresh recovers without a restart** -> `/lunaroute` → Refresh models (or
  `opencode reload`) lists the real catalog again; the placeholder is gone.
- [ ] **Placeholder is usable-shaped** -> select it and send a prompt: the gateway answers
  with a normal model error, the TUI reports it, nothing crashes.
- [ ] **Logged out** -> one `lunaroute/login` model named "Log in with /connect".
```

- [ ] **Step 3: Run the full check**

Run: `npm run check`
Expected: typecheck clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/smoke-checklist.md
git commit -m "docs(xn2w): troubleshooting for an unavailable model catalog + smoke rows"
```
