---
name: begin-work
description: Use when starting work on a kata-tracked issue in this repo — e.g. "begin work on 9t8x", "start on kata#9t8x", "let's work on <ref>". Sets up claim, worktree, and design alignment before any implementation.
---

# Begin Work

Argument: `<kata-ref>` — a kata short_id (`9t8x`), cross-project ref (`kata#9t8x`), or full ULID.
If no ref was given, run `kata next --unowned --agent`, propose the top issue, and wait for a pick.

## 1. Claim the kata

```bash
kata show <ref> --agent          # read it first: right issue? still open? already owned?
kata claim <ref> --agent
kata meta set <ref> work.attention ok --agent
```

If the issue is owned by someone else or blocked, stop and report — don't `--force`.

## 2. Worktree + feature branch

Repo convention: worktrees live in `.worktrees/` (gitignored), branch named `<ref>-<slug>`.
`slug` = 2–4 lowercase-hyphenated words from the issue title (see existing:
`.worktrees/y992-callback-acao`, `.worktrees/nrjp-nonchat-catalog-filter`).

### Liveness lock — claim before creating or reusing

Each worktree has a sibling lock `.worktrees/<ref>-<slug>.lock` (`.worktrees/` is
gitignored), one JSON line: `{"controller": "<CONTROLLER_ID>", "seen": "<ISO ts>"}`.
The lock lives under the **main checkout** (not inside the worktree), so every snippet
below resolves the main root first — this must work from any worktree as well as from
the main checkout. It is discoverable from any checkout: any create/reuse path resolves
the worktree dir first, and the lock sits right next to it. Two live controllers silently
interleaving commits on one branch is the kata `012e` incident (lunaroute-pi-extension)
— never share a worktree.

`CONTROLLER_ID`: prefer a real per-session id when the host provides one
(pi: `$PI_SESSION_ID`). OpenCode injects none into tool shells, so default to the
fallback below; when running concurrent agents on one machine, export a distinct
`KATA_SESSION_ID` (or `OPENCODE_SESSION_ID`) per session to restore the guarantee.

Run the claim first — creation is **atomic** (noclobber), so two cold-starting
controllers can never both believe they own a fresh lock (the check-then-write race
defeats the whole lock); it refuses a live worktree, takes over a stale one with a
warning, and (re)writes the lock:

```bash
ref="<ref>"; slug="<slug>"
# main checkout root — the first worktree in the list, valid from any worktree or the main checkout
main_root="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
lock="${main_root}/.worktrees/${ref}-${slug}.lock"   # sibling of the worktree dir, under the main checkout
mkdir -p "${main_root}/.worktrees"
CONTROLLER_ID="${OPENCODE_SESSION_ID:-${KATA_SESSION_ID:-$(whoami)@$(hostname -s)}}"
stamp() { printf '{"controller": "%s", "seen": "%s"}\n' "$CONTROLLER_ID" "$(date -Iseconds)"; }

if ( set -o noclobber; stamp > "$lock" ) 2>/dev/null; then
  : # created atomically — we own it; proceed
else
  # Lock exists. Read it, then decide: live-foreign → stop; stale or ours → takeover.
  seen=$(sed -n 's/.*"seen": *"\([^"]*\)".*/\1/p' "$lock")
  ctl=$(sed -n 's/.*"controller": *"\([^"]*\)".*/\1/p' "$lock")
  age=$(( $(date +%s) - $(date -d "$seen" +%s 2>/dev/null || echo 0) ))
  if [ "$ctl" != "$CONTROLLER_ID" ] && [ "$age" -lt 2700 ]; then   # 45 min staleness window
    echo "STOP: worktree .worktrees/${ref}-${slug} is actively driven by ${ctl:-unknown}, last seen ${seen:-unparseable}. Report to the user and do not proceed."
    exit 1
  fi
  # Takeover: re-read immediately before removing (shrinks the window where we would
  # remove a lock that turned fresh under us), then create through the same atomic
  # gate — exactly one controller can win creation, so a takeover loser stops safely.
  rm -f "$lock"
  if ! ( set -o noclobber; stamp > "$lock" ) 2>/dev/null; then
    echo "STOP: lost the takeover race for $lock — another controller claimed it. Report to the user."
    exit 1
  fi
  [ "$ctl" != "$CONTROLLER_ID" ] && echo "WARNING: took over stale lock from ${ctl:-unknown session} (last seen ${seen:-unparseable lock})"
fi
```

- No lock → created atomically; proceed.
- Fresh lock (< 45 min) from a different controller → **stop and report**
  ("worktree `<path>` is actively driven by `<controller>`, last seen `<ts>`") and ask
  the user. Do not reuse, do not force-share.
- Own controller id (crashed prior run) → takeover path rewrites it; proceed.
- Stale lock → takeover with the warning above; proceed.
- Residual race, stated honestly: between reading the lock and removing it for
  takeover, another controller could in principle refresh it. The atomic-create gate
  still guarantees exactly one owner (a takeover loser sees a fresh foreign lock and
  stops); keep the read→rm window minimal and don't interleave other work inside it.

Then create the worktree (skip if it already exists — you just claimed it) and stamp it:

```bash
git worktree add .worktrees/${ref}-${slug} -b ${ref}-${slug}
kata meta set <ref> work.branch ${ref}-${slug} --agent
```

Do all work inside the worktree, not the main checkout.

**Heartbeat:** while working, refresh the lock at each task/milestone (or alongside any
`kata meta` update) so a long stretch of work doesn't look abandoned — using the same
main-root-resolved `$lock` from the claim snippet (a plain relative
`.worktrees/...` path inside a worktree points at a directory that does not exist
there, which is exactly how a live session ends up looking stale):

```bash
printf '{"controller": "%s", "seen": "%s"}\n' "$CONTROLLER_ID" "$(date -Iseconds)" > "$lock"
```

## 3. Align on design before code

Read the kata body, comments, and metadata (`kata show <ref> --agent`,
`kata meta get <ref> --agent`), then explore intent and design with the user before
writing code. If a brainstorming skill is available in this OpenCode install (e.g.
superpowers), use it — its approval gate applies. Otherwise: present the proposed
approach (scope, files, tests) and wait for explicit approval. Do not write code until
the design is agreed.

## While working

Keep `work.*` truthful: on any state change set
`kata meta set <ref> work.attention stuck|needs-human|ok --agent` plus a one-line
`work.attention_msg`. Close only verified work:
`kata close <ref> --done --message "<scope + verification>" --commit <sha>`.
Refresh the worktree liveness lock (see step 2) at each task/milestone so concurrent
sessions see you as live; `end-work` releases the lock on the close path.
