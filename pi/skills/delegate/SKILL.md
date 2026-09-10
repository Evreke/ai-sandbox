---
name: delegate
description: Orchestration playbook for multi-worker fan-outs via the pi-delegate extension (topologies, brief anatomy, merge gates, failure handling). The `delegate` tool itself needs NO skill — for any spawn, collect, or status call, use the tool directly. Load this only when planning a multi-worker run (per-ticket, per-axis, per-hypothesis, per-repo) or diagnosing failed delegation.
---

# Delegate work via the pi-delegate extension

**TOOL FIRST — non-negotiable.** If the `delegate` tool is in your tool list, it is
the ONLY way to spawn, prompt, or collect a worker. Never shell out to `herdr agent
start/prompt/wait` when the tool exists — the manual ritual in REFERENCE.md is a
fallback for sessions where the extension is MISSING, nothing else. Reading
REFERENCE.md for topologies or anti-patterns is fine; following its spawn ritual
while the tool is available is a bug.

You are the orchestrator. You decompose, brief, verify, merge. The `delegate` tool
(registered by the `pi-delegate` extension) owns the spawn mechanics: placement,
agent start, prompting, settle observation, strict report collection.

## Loop

1. **Decompose** — bounded, single-outcome tasks. Single tier: everything
   spawns on the configured default (beta/frontier) — do not pass tier,
   provider, or model overrides.
2. **Brief** — one file per worker at `/tmp/exchange/{TASK}/brief-<name>.md`:
   ROLE (tier + read/write scope) / TASK (one outcome) / CONTEXT (file pointers only,
   paste nothing the worker can read) / CONSTRAINTS (owned surface first, then explicit
   negatives) / OUTPUT (exact report path + JSON schema) / BUDGET.
   Names: `[a-z][a-z0-9_-]{0,31}`. Briefs are name-agnostic: the tool tells the worker
   its canonical name — never hard-code worker names or report filenames in briefs;
   write "report-<your assigned worker name>.json".
3. **Spawn** — call `delegate` per worker (parallel tool calls for fan-out).
   - `mode: "probe"` first when fanning out ≥3 workers (smoke gate).
   - `mode: "tab"` for sub-orchestrators and file-slice fan-outs; `worktree` (default)
     for independent tickets. One worktree = one worker = one branch.
   - Blocking call. Esc detaches — the worker keeps running; recover via `delegate_status`.
4. **Verify** — the report file is the completion criterion, never `status: done`.
   Check the report verdict against the brief's acceptance criteria with file:line evidence.
   `status: "fail"` in a valid report is an honest completion, not a tool error.
5. **Merge** — you are the single merge gate. Workers commit in their own scope; they
   never merge, never push. Verify before merging; decide merge order yourself.
6. **Teardown** — `/delegate-teardown` when the task is done. Never leave workspaces behind.

## Failure handling

| Tool result | Meaning | Your move |
|---|---|---|
| `E_REPORT_MISSING` / `E_REPORT_INVALID` | worker settled without a valid report | read the pane (`herdr agent read`), diagnose root cause, **diagnosed retry** — new brief naming the wrong path, root cause, fix shape. Never retry verbatim. ≤2 repeats per issue, then escalate to the user |
| `E_TIMEOUT` | settle wait expired, worker alive | end your turn — the background watcher wakes you on report-ready/question/death; `delegate_status` polling stays valid. Do not re-spawn, do not sleep |
| `E_NAME` | name taken by a live agent | choose a different name |
| `E_PROMPT_STALLED` | pane not at a prompt | inspect via `delegate_status`, answer or re-brief |
| `E_PLACE` / `E_START` | placement/start failed | read the embedded herdr stderr; reconcile via `herdr workspace list` |

Report/manifest conventions, worktree authority rules, topologies (ticket, file-slice,
axis, hypothesis, role chain, two-tier swarm), and anti-patterns: [REFERENCE.md](REFERENCE.md).
