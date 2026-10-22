# Catalog fetch failure — retry, then say so (kata xn2w) — design

Status: approved 2026-10-22; amended after fresh-eyes review (glm-5.3, max reasoning) — see
"Review amendments" at the end. Size: small change.
Evidence: live rigs on opencode 2.0.29 and 2.1.2 (sandboxed HOME, local-dir plugin entry,
stub gateway); matrix recorded in the kata body.

## Intent and why

The model catalog is fetched once per location (project dir) when that location first
loads (`src/index.ts` setup -> `provider.register()` -> `load()` -> `fetchCatalog()`).
Every failure path ends in `models = []`: one-shot 5 s fetch, no retry, no persisted
catalog. A user who started OpenCode, or opened a session in a new folder, while the
gateway was unreachable sees an empty LunaRoute model list — with no explanation and no
recovery except a reload they have no reason to suspect. That is the report behind this
kata (OpenCode 2.1.2, extension 0.4.0: "opened a new session and got no models").

## Goals

- A transient failure at load time heals itself: retry once before giving up.
- When it still fails, the failure is visible where the user looks (`/models`, the model
  picker, the Refresh-models toast) and names the remedy, instead of an empty list.
- The auto default-model pick never selects a placeholder.

## Non-goals

- No persisted last-known-good catalog. A stale list can offer models the org no longer
  allows (403 on first use), which looks worse than an honest "couldn't load".
- No background retry after setup. `/lunaroute` -> Refresh models and `opencode reload`
  already re-fetch (verified on 2.1.2), and the placeholder now points at that.
- No change to MCP/tool registration gating (they read the credential, not the catalog).

## Anti-goals

- A placeholder that can be mistaken for a working model with no explanation.
- Retrying a failure that cannot heal (4xx, a captive-portal HTML body).
- Blocking a location's first load for tens of seconds on a hung endpoint.

## Constraints

- `provider.load()` is on the location's critical path, and setup re-runs on every
  `location.reload()` (settings live-apply, Refresh models) and on every credential event.
  The retry budget has to stay small: typical failures — DNS, connect refused — fail in
  milliseconds, so a retry is nearly free; only a hung endpoint burns a timeout.
- v2 registers a provider with zero models silently; `/connect` lists integrations, so the
  provider stays reachable regardless — the placeholder exists for `/models` and the picker.
- v1 precedent (kata 3xsy) is `injectPlaceholderModel`: additive-only, one labeled model,
  replaced wholesale by the real catalog. Port the idea, not the machinery.

## Approaches considered

1. **Retry + visible failure (chosen).** Retry the fetch once; on final failure register
   one labeled model naming the failure and the remedy. No state kept between runs.
   Trades a slightly longer worst-case load for honesty and self-healing.
2. **Retry + persisted last-known-good fallback.** Survives a cold offline start, but shows
   models that may no longer be permitted; needs a cache file, invalidation and a staleness
   surface. Rejected by the user in favour of an explicit failure message.
3. **Retry only, keep the log line.** Cheapest, but plugin `console.*` does not reach
   `opencode.log` (re-verified on 2.1.2), so the user still sees an unexplained empty list.
   Rejected: it does not solve the report.

## Decisions (locked)

- `fetchCatalog` retries: **2 attempts, 1000 ms apart**, 5 s timeout each (worst case 11 s
  of a location's load, then a placeholder). A third attempt only helps a *hung* endpoint,
  which cannot heal inside the budget, so it buys nothing where it costs most.
- Retry on transport errors, 5xx and 429. **Never** retry 4xx. A body that fails to parse
  (`res.json()` rejects — e.g. a captive-portal HTML page) is `malformed catalog body` and
  is **not** retried: parse it in its own try/catch so it is not mistaken for a transport
  throw.
- Final failure, or a catalog that maps to zero models, with no usable models already in
  hand -> register **one** model named
  `Couldn't load models — run /lunaroute → Refresh models`, id `login` (v1 id, kata 3xsy),
  limits `DEFAULT_CONTEXT_LIMIT` / `DEFAULT_OUTPUT_LIMIT` (repo defaults, not new numbers).
- A later successful fetch replaces the placeholder. OpenCode's `editor.add` replay
  semantics (replace-by-provider vs merge-by-id) are **assumed, not proven**: verified live
  before close; if models merge by id, `apply()` gains an explicit placeholder removal.
- A failed **refresh** keeps the last good catalog (existing behaviour, existing test);
  the placeholder is only for the case where nothing usable exists.
- Logged out (no credential), and a credential lookup that throws, use the same mechanism
  with `Log in with /connect` — the advice differs, so the text differs. (My call, approved
  with this design; it also covers a credential that fails to resolve, which is
  indistinguishable from logged out.)
- `defaultModelId()` skips the placeholder id, so the plugin never sets
  `lunaroute/login` as the session default.
- The TUI's Refresh-models toast stops counting the placeholder as an available model and
  reports a failure when only the placeholder is left — otherwise the remedy the
  placeholder names reports success.
- The warn log keeps the real reason (`LunaRoute: catalog fetch failed: HTTP 500`).

## Left to the builder

- Exact retry/delay wiring inside `fetchCatalog` (loop shape, where the sleep lives; the
  attempts and delay are constants, only `sleep` is injectable).
- Which existing tests change: provider (`zero models … logged out`, `zero models … failed
  fetch`), entry (`providerAdded[0].models` equals `[]`), models (the `boom` case must pass
  a no-op sleep once a transport error retries), TUI (fake list gains ids).
- README wording for the new troubleshooting entry, the corrected "before your first
  login" sentence, and the smoke-checklist rows (recorded live, not pre-checked).

## Review amendments (fresh-eyes review, glm-5.3, 2026-10-22)

Accepted: retry 3 -> 2 attempts with the budget rationale above; malformed-body parse
split out of the transport path; `resolveKey` throw uses the login placeholder; placeholder
limits use repo defaults; Refresh toast truthfulness; `tests/entry.test.ts` and the
`tests/models.test.ts` `boom` case added to the plan; smoke rows recorded only after live
verification; live checks added for placeholder replacement and for OpenCode auto-picking
the placeholder when no default is set; v2 port design decision #3 marked superseded.

Rejected: none.

## Supersedes

`docs/superpowers/specs/2026-10-15-opencode-v2-plugin-api-port-design.md`, locked decision
3 ("No placeholder model.") — reversed here with the rationale above.
