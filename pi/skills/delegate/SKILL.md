---
name: delegate
description: Delegate work to parallel pi workers over herdr. Use when the user asks to delegate, spawn workers or sub-agents, fan out tasks (per-ticket, per-axis, per-hypothesis, per-repo), orchestrate a multi-agent run, collect worker reports, or re-delegate failed work.
---

# Delegate work over herdr

The contract: you are the orchestrator. You decompose, brief, spawn, collect, verify, merge. Execution lives in worker sessions — separate pi processes in herdr panes, each with a fresh context. Tier routing: the decision tier (frontier-class) briefs, reviews, and synthesizes; the execution tier (flash-class) implements, fixes, enumerates, verifies. Prompt the execution tier tight and structured — it is a small model.

## 1. Pre-flight

Gate: `test "${HERDR_ENV:-}" = 1`. If it fails, report that delegation over herdr is unavailable and stop.

1. Choose the transport per worker:
   - **Interactive worker** (herdr pane, session kept) — the default; supports follow-up prompts, questions, and mid-run re-briefs.
   - **Headless one-shot** (`pi -p`) — a single artifact from a throwaway probe. Add `--approve` (headless modes skip the trust prompt) and narrow tools (`--tools read,bash`).
2. Assign tier and budget per worker: execution work ≤ ~150k tokens; repeats ≤ 2 per issue; iterations ≤ 5 for write/review loops.
3. Create the exchange dir: `mkdir -p /tmp/exchange/{TASK}` (`{TASK}` = short slug).
4. For a fan-out of ≥3 workers, run a smoke test first: one probe worker prompted to reply exactly `OUTPUT: OK` (catches dead panes, wrong flags, overloaded tiers).

Completion: every planned worker has a name, tier, budget, and brief path. Names match `[a-z][a-z0-9_-]{0,31}`, unique among live agents.

## 2. Brief

One brief file per worker in the exchange dir (`brief-<name>.md`). The prompt sent to the pane is one line pointing at it — long prompts wrap and mangle in narrow panes.

- **ROLE** — one line: tier, read/write scope ("You are facts-worker F1, read-only").
- **TASK** — bounded, single outcome. Verbatim artifacts (exact fix shape, exact text) for risky changes; equivalence argument for rewrites.
- **CONTEXT** — file pointers only: spec path, prior reports, worktree path, branch, base commit. Paste nothing the worker can read.
- **CONSTRAINTS** — the owned surface first ("You edit exactly these files"), then the danger surface as explicit negatives (no git-write commands, no builds, no docker, no tool X).
- **OUTPUT** — exact report path + format, ending: "Before replying, verify the report file is written. Reply with only the file path."
- **BUDGET** — tokens / time slots / iterations.

Completion: brief exists on disk; the planned prompt is a single `Read <path> …` line.

## 3. Spawn

Layout first — `agent start` needs an existing available shell pane and never creates one. Split sibling panes from your own, `--no-focus`, same cwd; alternate right/down so no pane gets sliver geometry.

```bash
# split + capture pane id
P2=$(herdr pane split --current --direction right --cwd "$PWD" --no-focus \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')

# start the worker (flags after --)
herdr agent start research-1 --kind pi --pane "$P2" --timeout 90000 -- \
  --provider llm-platform --model "tensorzero::function_name::flash" --thinking high

# send the brief and wait for the run to settle
herdr agent prompt research-1 "Read /tmp/exchange/{TASK}/brief-research-1.md and follow its instructions exactly. Reply with only the file path." --wait --timeout 1800000
```

Fan-out in one bash call, bookkeeping to a file:

```bash
for i in 1 2 3; do
  herdr pane split --current --direction down --cwd "$PWD" --no-focus \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["pane"]["pane_id"])' >> /tmp/exchange/{TASK}/panes.txt
done
i=0
while read -r p; do
  i=$((i+1))
  herdr agent start w$i --kind pi --pane "$p" --timeout 120000 -- \
    --provider llm-platform --model "tensorzero::function_name::flash" > /tmp/exchange/{TASK}/w$i.start.json 2>&1 &
done < /tmp/exchange/{TASK}/panes.txt
wait   # all starts resolved before prompting
```

Startup `--timeout` 60–180 s; prompt `--wait` timeout = expected task length (10–30 min for execution work).

Completion: `herdr agent get <name>` shows the worker working (or blocked) for every spawn.

## 4. Collect

The report file is the result. `herdr agent read` is for status and short answers only — rows that leave the alternate screen never reach scrollback, so long worker output read from the terminal is silently truncated.

1. For each worker, read the agreed report file with the `read` tool. `ENOENT` = the worker produced nothing: treat as a failed spawn, not an empty result.
2. Poll instead of blocking when running other work: `herdr agent list`, or `herdr agent get <name>` per worker; status vocabulary `idle | working | blocked | done | unknown`. `done` means the turn ended — the report file is the completion criterion, not the status.
3. `blocked` = an approval or question UI. Read the pane, answer the question (or `send-keys <name> esc` to decline and re-brief).
4. Cross-check conflicting worker reports by spawning one tie-breaker verifier with both reports as CONTEXT, or resolve it yourself from source.

Completion: every worker has a report file on disk, read by you.

## 5. Verify and re-delegate

You are the single merge gate: workers commit in their own worktree/scope; they never merge, never push, never open PRs.

- Verify against the brief's OUTPUT: acceptance criteria as PASS/FAIL with file:line evidence.
- A failed worker's result is input, not waste: **replace the failed prompt with a diagnosed retry** — a new brief that names the wrong path taken, the root cause, and the required fix shape. A verbatim retry is a banned move; the diagnosed retry is the move. ≤2 repeats per issue, then escalate to the user.
- Repair prompts get tighter, never looser.

Completion: DoD verified (tests/acceptance criteria), all changes accounted for, merge order decided by you.

## 6. Teardown and audit

1. Close panes you created: `herdr pane close <pane_id>` per worker pane. Release names implicitly.
2. For a run of ≥3 workers, close with an audit from the session store: workers spawned, wall time per worker, tokens per tier, repeats — parse `usage` blocks in `~/.pi/agent/sessions/…/<session>.jsonl`, not estimates.

## Reference — supervision

- Stuck interactive worker: `herdr agent send-keys <name> ctrl+c`, then re-brief. Headless liveness: `nohup … &` + `ps -p $!` check, `pgrep -af "pi .*-p"`.
- Mid-run correction to a working worker: send a short steering prompt (state + instruction), e.g. "STEP 0 resolved upstream — do not cherry-pick, continue with STEP 1".
- A resumed session can sit inside a worker pane: `herdr agent start … -- --session <path-to.jsonl>`.
- Tier overload: re-delegate to a different tier (e.g. flash → chat/beta) rather than queuing behind an overloaded one.

## Reference — topologies

| Topology | Shape | Use |
|---|---|---|
| Ticket fan-out | one ticket = one worktree = one branch = one agent | independent implementation tickets |
| File-slice fan-out | N agents, one worktree, disjoint file lists per agent | mass mechanical edits (javadoc, renames) |
| Axis fan-out | one reviewer per review axis → synthesize under your recommendation | code review, audits |
| Hypothesis fan-out | ≥3 independent workers on orthogonal hypotheses; hold the superposition until evidence collapses it | diagnosis, ToT investigations |
| Role chain | investigator → planner → developer → verifier → narrator over one artifact | feature delivery with human-facing report |
| Two-tier swarm | root → per-repo/tech-lead orchestrators → workers | multi-repo epics (cap depth at 3; workers that delegate are the exception, not the rule) |

## Reference — anti-patterns

- Brief pasted into the prompt → put it in a file; the prompt points at it.
- Long result read from the pane → read the report file.
- `done` trusted as completion → the report file exists is the criterion.
- Failed prompt retried verbatim → diagnosed retry with root cause + fix shape.
- Workers merging or pushing → orchestrator is the merge gate; workers commit in scope only.
- Parallel builds in one worktree → one build runner at a time; file-disjoint scopes.
- Interactive tools with rich TUI inside worker panes → workers answer questions in files; you poll and answer.
- Unbounded fan-out → smoke test first, cap concurrency, budget per tier.
- Briefs that omit the exchange dir or report path → the loop has no collection point; always OUTPUT first.
