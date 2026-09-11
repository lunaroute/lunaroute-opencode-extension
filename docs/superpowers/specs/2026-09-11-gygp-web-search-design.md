# First-class web_search — kata gygp design (approved 2026-09-11)

v2, approved after fresh-eyes review (independent reviewer, verdict BLOCK on
v1) + designer re-pass + pi's actual implementation (npm
@lunaroute/pi-extension@0.9.0) as the parity authority. Approved decisions:
D1 = (a-prime) settings read-side ported now (write path + TUI stay in f2aj);
D2 = coexistence (coverage-driven rule, revisited by kata 5715).
authority. Open decision points: D1-mode, D2-confirm.

## Facts (reclassified after review)

**Type-verified (node_modules/@opencode-ai/plugin@1.18.25; peer dep ^1.17.20):**
- `Hooks.tool?: { [name]: ToolDefinition }`; `tool()` takes
  `{ description, args (zod raw shape), execute(args, ctx) }`; `ToolContext.abort`;
  `ToolResult` = string | `{ title?, output, metadata?, attachments? }`.
- `tool.definition` only mutates description/parameters — NOT an availability
  gate. Dropped from the design (v1 overclaim).

**Researched runtime facts (NOT type-verifiable here; sources cited):**
- Host truncates/spills plugin tool output (`metadata.truncated` + `outputPath`)
  → we return full text. Source: kata research (OpenCode tool registry
  `fromPlugin`); consistent with the plugin types not modeling it.
- Plugin tool takes precedence over same-named builtin. Source:
  opencode.ai/docs/plugins (verified 2026-09-11). Not relied on (different names).
- MCP server tools register with the server name as prefix (e.g.
  `lunaroute_web_search`) → no hard collision with our `web_search`. Source:
  opencode.ai/docs/mcp-servers (verified 2026-09-11).

**Pi parity facts (from pi 0.9.0 source, authoritative):**
- web_search schema: `query` (string, required), `count` (number 1–20,
  optional), `provider` (string, optional; per-call wins over settings default;
  undefined → omit key on wire). Description: "Search the web through
  LunaRoute. Returns normalized results (title, url, snippet, date). Issue
  multiple web_search calls in one message to run searches in parallel."
- web_fetch handler EXISTS in pi (schema `{url}`, passthrough text), registered
  only when tools/list offers a fetch-pattern tool (server does not today).
- MCP client: stateless Streamable HTTP — one JSON-RPC POST per call
  (Accept: application/json, text/event-stream), SSE-tolerant decode, lazy
  OPTIONAL initialize handshake (stateless servers accept bare tools/call; a
  returned Mcp-Session-Id is not propagated), `isError` → throw.
- Server tool name resolution: pattern-match tools/list
  (`/^web_?search$/i`, `/^search_?web$/i`, `/_web_?search$/i`), env override
  `LUNAROUTE_MCP_WEB_SEARCH_TOOL` (exact name, must be present in tools/list).
  Same for fetch patterns.
- Registration: every session_start (reload/resume/fork re-fire), never
  cached, failures silent + retried next session_start; post-login fire-and-
  forget re-registration with the fresh key.
- Settings (pi bjy9 = our f2aj): `<agentDir>/lunaroute.json`
  `{mcp, webTools, searchProvider, imageTools, convertTools}`; tolerant read
  (absent/invalid → defaults, all "on"/"server"); `webToolsEnabled`: env
  `LUNAROUTE_WEB_TOOLS` off|0|false → off, else file; `resolveSearchProvider`:
  "server" → undefined (omit). Default provider resolved at CALL time from the
  file (live apply).
- Output shaping: server returns normalized JSON `{query, provider,
  results[{title,url,snippet,published_date,score}]}` as content text;
  tolerant parse (failure → rawText passthrough); numbered-result formatting.
- Detection: pi pattern-matches OTHER extensions' tool names at session_start
  (getAllTools). NO OpenCode equivalent exists (plugins cannot enumerate
  tools at init) → detect-and-backfill is DROPPED, documented as a limitation.
  Plugin-vs-plugin `web_search` name collision behavior is unverified.

## Decisions

**D1 · Settings (kata decision 3 compliance) — OPEN, two modes.**
- (a′) RECOMMENDED: port pi's settings READ-side now — `readSettings`
  (tolerant), `webToolsEnabled(env, settings)` incl. `LUNAROUTE_WEB_TOOLS`
  env escape hatch, `resolveSearchProvider`, file at
  `<XDG data>/opencode/lunaroute.json` (next to auth store; path is an
  assumption f2aj may relocate). Write path + TUI + remaining toggles stay in
  f2aj. Satisfies "file = source of truth, read per execute" + the
  "file changed after init → next call follows" regression test. Low divergence
  risk: it is a port of pi's shipped contract, not an invention.
- (a) original: defer everything to f2aj; ship login-gated + per-call
  `provider` only. Kata decision 3 then partially unmet (reviewer: major).

**D2 · MCP dedupe — confirm.** Rule (5715's option (b) applied honestly):
MCP registration is coverage-driven in principle; at gygp's coverage (web
tools only; the server also serves generate_image/convert_document/…) the
hosted MCP stays registered → duplicate surfaces (`web_search` +
`lunaroute_web_search`) coexist, no hard collision. Pi ships exactly this
(webTools + mcp both default "on"). 5715 revisits skip-when-covered when its
coverage could be complete; OpenCode's mcp config shape has no per-tool filter
(src/mcp.ts reconciler injects a whole server entry), so "MCP for uncovered
tools only" is not implementable today. README documents the rule + user
escape hatches (OpenCode's own config can disable the server/tools; f2aj
ports the `mcp` toggle).

**D3 · Registration gate & probe lifecycle.** At factory-returned-function
invocation: resolve auth (valid key required — logged out → NOT registered,
kata test); probe tools/list (short timeout, ~3–5 s) ONLY when valid.
NO memoization, NO failure caching (pi retries every session_start; repo
precedent: catalogMemo keys by url+credential and never caches failures).
Probe result picks server tool names by pattern + env override. Both web tools
register independently iff offered (web_fetch dormant until the server ships
it — kata test's parenthetical). Post-login appearance depends on instance
reload rebuilding the tool map — UNVERIFIED (5715/f2aj spike question;
postLoginRefresh's early-return when a model is already set may skip the
config.update that triggers reload); fallback documented: restart.
Mid-session logout: tool remains registered; execute re-reads the key and
fails cleanly ("Run /connect …") — fail-safe, matches the fixed tool map.

**D4 · Execute mechanics.** Fresh client per execute (one stateless POST per
call — no shared mutable state across concurrent executes; pi's nextId counter
is the only shared state and is harmless), lazy key re-read per execute
(rotation reach-through), `context.abort` threaded, full text returned (no
local truncation/spill — host does it), payload parsed + formatted per pi
(numbered results; rawText fallback), `metadata` carries provider/count.

**D5 · Args.** Exact pi schema (see parity facts): `query` + `count` +
`provider`. zod via `tool.schema` (no undeclared transitive zod dependency).

**D6 · Structure (pi-mirroring).** `src/web-tools.ts` (client + both tool
builders + registration orchestrator, exported client for 5715),
`src/settings.ts` (if D1=a′), wiring in `src/index.ts` factory function;
testability seam: `PluginDeps` gains env/home/fs/storeKey (the config hook's
runtime seam does not reach the tool gate). Tests:
`tests/web-tools.test.ts` (+ `tests/settings.test.ts` if a′) with an
in-process fake MCP server + fake auth store.

## Tests (kata list + review additions)

- Logged out → not registered. Login-after-start (factory re-invocation with
  fresh store) → registered.
- Server without web_search in tools/list → not registered; with it →
  registered; web_fetch registers iff offered.
- Execute: lr_ key + attribution headers on the wire (fake MCP server);
  normalized payload → formatted output; malformed → rawText passthrough;
  `isError` → thrown error.
- Provider: per-call arg wins over settings default; settings file changed
  after init → next call follows (D1=a′); absent everywhere → key omitted.
- Env `LUNAROUTE_WEB_TOOLS=off|0|false` → not registered (D1=a′).
- Mid-session logout → execute-time clean error (tool registered earlier).
- Concurrent executes → no cross-talk (stateless client per execute).
- Server-tool-name pattern pick + `LUNAROUTE_MCP_WEB_SEARCH_TOOL` override
  (present-in-list required; absent override falls through to pattern).

## Docs

README MCP section: coexistence rule (D2), duplicate-surface rationale,
escape hatches; detect-and-backfill dropped (no plugin tool enumeration);
plugin-vs-plugin collision unverified. docs/smoke-checklist.md entry.
