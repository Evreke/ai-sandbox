# Regression checklist — run before releasing

Unit tests (`npm test`) cover the pure security/logic boundary. Everything below
exercises the interactive TUI, which cannot be meaningfully unit-tested — it
needs a real terminal, a live agent, and keystrokes. Run it in a Herdr pane
(~5 minutes) with the version under test.

## Setup

```bash
# isolated project so the globally installed copy doesn't conflict
mkdir -p ~/projects/grill-deck-regression && cd ~/projects/grill-deck-regression

# split a pane there, then (tool name collides with a global install → -ne):
herdr pane split --current --direction right --cwd "$PWD" --no-focus
herdr agent start gdtest --kind pi --pane <pane-id> --timeout 60000 -- \
  -ne -e /path/to/ai-sandobx/pi/extensions/grill-deck/index.ts --model zai/glm-5.3-flash
```

Also run `npx tsc -p <strict-tsconfig>` (noUnusedLocals, allowImportingTsExtensions,
paths to installed pi packages) as the type gate.

## Scenarios

| # | Steps | Expect |
|---|---|---|
| R1 | Prompt: call `grill_deck` with 3 questions, each with recommendation + 2 choices. Keys: `a`, `A` (deck auto-submits after `A`) | Header shows `model-authored — verify before accepting`; `Accepted N recommendations`; tool result `✓ Q1–Q3`; no widget line above the editor |
| R2 | 3 questions, Q2 without recommendation/choices. Keys: `s` (defer Q1), `enter` (Q2 → options view, single Enter), `1` (custom), type text, `enter`, `a` (Q3 → auto-submit) | Options view shows only custom+defer for Q2; result has DEFERRED / user-wrote / accepted lines |
| R3 | New deck, then `esc` | "User cancelled the question deck. Do not immediately re-ask…" and the model doesn't re-ask; no round entry in session file |
| R4 | Prompt: call with 40 questions | Tool result rejects: "Too many questions (40)…" — no deck opens |
| R5 | `/grill`, change one answer, `ctrl+s` | Deck reopens with answers prefilled; model receives "Revised answers for grill deck round N" |
| R6 | Prompt the model to embed `ESC[31m` + BEL (JSON `\u001b`/`\u0007`) in a title | Title renders as plain text; `herdr pane read --format ansi` shows only theme styling — no `\x1b[31m`, no `\x07` |
| R7 | Exit pi, restart with `-c` (continue) | Round history rebuilt from session replay; `/grill` still reopens the last round; no widget |
| R8 | Poison a session entry's payload: set one answer's `kind` to `"hax"`, lace another's `label` with `ESC[31m`, restart with `-c` | Invalid answer dropped from counts; label renders sanitized; no escape sequences at ANSI level |
| R9 | Fresh deck, defer every question with `s`; last `s` auto-submits | Result all DEFERRED; no ctrl+s needed |
| R10 | `/grill` on a fully-settled round, change nothing, `esc` | Deck does NOT auto-submit on open; "No changes" after revise-without-changes path stays intact |

## Post-flight

- Session file (`~/.pi/agent/sessions/<project>/…jsonl`): cancelled decks wrote
  nothing; round/revision entries are well-formed.
- `npm pack --dry-run`: tarball contains `index.ts`, `lib.ts`, docs, `skills/` —
  no tests, no node_modules.
- Close the test pane and delete the scratch project when done.
