# Catalog fetch failure — retry, then say so (kata xn2w) — design

Status: approved (2026-10-22). Size: small change.
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

- A transient failure at load time heals itself: retry a few times before giving up.
- When it still fails, the failure is visible where the user looks (`/models`, the model
  picker) and names the remedy, instead of an empty list.
- The auto default-model pick never selects a placeholder.

## Non-goals

- No persisted last-known-good catalog. A stale list can offer models the org no longer
  allows (403 on first use), which looks worse than an honest "couldn't load".
- No background retry after setup. `/lunaroute` -> Refresh models and `opencode reload`
  already re-fetch (verified on 2.1.2), and the placeholder now points at that.
- No change to MCP/tool registration gating (they read the credential, not the catalog).

## Anti-goals

- A placeholder that can be mistaken for a working model with no explanation.
- Retrying a failure that cannot heal (4xx: revoked key, bad baseURL).

## Constraints

- `provider.load()` is on the location's critical path; the whole retry budget has to stay
  small (typical failures — DNS/connect refused — fail in milliseconds, so retries cost
  almost nothing; only a hung endpoint burns a timeout).
- v2 registers a provider with zero models silently; `/connect` lists integrations, so the
  provider stays reachable regardless — the placeholder exists for `/models` and the picker.
- v1 precedent (kata 3xsy) is `injectPlaceholderModel`: additive-only, one labeled model,
  replaced wholesale by the real catalog. Port the idea, not the machinery.

## Approaches considered

1. **Retry + visible failure (chosen).** Retry the fetch briefly; on final failure register
   one labeled model naming the failure and the remedy. No state kept between runs.
   Trades a slightly longer worst-case load for honesty and self-healing.
2. **Retry + persisted last-known-good fallback.** Survives a cold offline start, but shows
   models that may no longer be permitted; needs a cache file, invalidation and a staleness
   surface. Rejected by the user in favour of an explicit failure message.
3. **Retry only, keep the log line.** Cheapest, but plugin `console.*` does not reach
   `opencode.log` (re-verified on 2.1.2), so the user still sees an unexplained empty list.
   Rejected: it does not solve the report.

## Decisions (locked)

- `fetchCatalog` retries: **3 attempts, 1 s apart**, same 5 s timeout each. Retry on
  transport errors, 5xx and 429; **do not retry 4xx** (cannot heal) and do not retry a
  malformed body (a captive-portal/login page will not fix itself). Sleep injectable so
  tests are instant.
- Final failure, or a catalog that maps to zero models, with no usable models already in
  hand -> register **one** model named
  `Couldn't load models — run /lunaroute → Refresh models`, id `login` (v1 id, kata 3xsy).
- A later successful fetch **replaces** the placeholder wholesale.
- A failed **refresh** keeps the last good catalog (existing behaviour, existing test);
  the placeholder is only for the case where nothing usable exists.
- Logged out (no credential) uses the same mechanism with `Log in with /connect` — the
  advice differs, so the text differs. (My call, approved with this design; it also covers
  a credential that fails to resolve, which is indistinguishable from logged out.)
- `defaultModelId()` skips the placeholder id, so a failed start never sets
  `lunaroute/login` as the session default.
- The warn log keeps the real reason (`LunaRoute: catalog fetch failed: HTTP 500`).

## Left to the builder

- Exact retry/delay wiring inside `fetchCatalog` (loop shape, where the sleep lives).
- Which existing test assertions change: the two provider tests that currently pin
  "zero models when logged out" and "zero models on failed fetch" now pin the placeholder.
- README wording for the new troubleshooting entry and the smoke-checklist rows.
