# grill-deck — onboarding

An interactive **question deck** extension for pi. It replaces the
"dump a wall of markdown questions and hope the free-text reply maps back"
pattern with a structured TUI: the agent hands all questions of a round to
one tool, you answer them in a single screen, and the agent gets clean
structured answers back.

Built for [grilling](./skills/grilling/SKILL.md)-style sessions —
design-tree interviews where each round presents the whole *frontier* of
askable questions — but it works for any batch of questions (checklists,
requirement gathering, triage).

---

## For users

### What you see

When the agent starts a round, the editor is replaced by the deck:

```
───────────────────────────────────────────────────────────────
 grill deck · 5 questions · 1 answered · model-authored — verify before
 accepting
───────────────────────────────────────────────────────────────
  ✓ Q1 Scope: what does 'PR review format' actually cover?
        (a) + (b) + (c) — description template, comment conv…
> · Q2 What is the primary pain driving this?
      What hurts today that this format must fix?
      ➡️ rec: (a) + (d) — vague descriptions and missing…
  · Q3 Scope of adoption: one repo or org-wide standard?
  · Q4 Who is the audience: humans, AI agents, or both?
  · Q5 Enforcement level: advisory, required template, or CI
    gate?

 ↑↓ move · Enter options · a accept rec · A accept all · e
 write · s defer · ctrl+s submit · Esc cancel
───────────────────────────────────────────────────────────────
```

- `✓` = answered · `·` = open · `⤳` = deferred (deliberately left open)
- The focused question (`>`) shows its body and the agent's `➡️` recommendation
- You cannot submit while questions are open — answer or defer each one
- The deck submits itself as soon as the last question is settled — no `ctrl+s` needed (revision sessions via `/grill` submit with `ctrl+s`)

### Keys

| Key | Action |
|---|---|
| `↑` `↓` | move between questions |
| `Enter` | open the options view — the recommendation (or current answer) is pre-highlighted as option 1 |
| `a` | accept the recommendation (explicit quick-accept, skips the options view) |
| `1`–`9` | pick a numbered option (in options view) |
| `e` | write a custom answer (free text, saved verbatim) |
| `s` | defer — keep the question open for a later round |
| `ctrl+s` | submit manually — a fresh deck auto-submits once everything is answered or deferred; `/grill` revision sessions submit with `ctrl+s` |
| `Esc` | cancel the deck (or leave the options/input view) |

In expanded view you always get, in order: **★ accept recommendation**, the
agent's choices, **✎ write a custom answer**, **⤳ defer**.

### Reviewing or changing answers

Run `/grill` — it reopens the **last** deck with all previous answers
prefilled. Change anything and submit: the agent receives a structured
"Revised answers" message and recomputes. Esc out if you only wanted to look.

### Deferred questions

`s` does not mean "no" — it means "not now". The agent is told the question
stays open in the design tree; expect it to re-surface in a later round
(marked `Q3 (deferred)`) once its prerequisites settle.

---

## For agents (LLMs)

### When to call `grill_deck`

Call it instead of printing questions as markdown whenever you are running a
grilling/interview round:

- **One call per round** — pass the *entire frontier*: every question whose
  prerequisites are already settled. Never split a round into several calls.
- **Question shape** — `id` (stable short id, reused across rounds for
  deferred/re-asked questions), `title` (one line), `body` (optional context),
  `choices` (optional concrete options), `recommendation` (your answer).
- **Do not** duplicate the recommendation inside `choices` unless it is
  genuinely one of them — "accept recommendation" is always offered separately.
- Later rounds: re-ask deferred questions with the same `id`, optionally
  suffixed `(deferred)` in the title for visibility.

### How to read the result

The tool result lists one line per question:

- `accepted your recommendation — "…"` — treat as settled
- `chose option N — "…"` — settled
- `user wrote — "…"` — settled, verbatim
- `DEFERRED — treat as still open` — stays in the tree; re-ask when unblocked

Then: recompute the frontier and call `grill_deck` again for the next round.
When the frontier is empty, summarize the shared understanding and **wait for
the user's confirmation before acting on it**.

### Edge cases

- **Esc (cancel)** — you get "User cancelled the question deck. Do not
  immediately re-ask…". Wrap up or ask what to change — don't loop.
- **Non-interactive mode** (`-p`, JSON) — the tool returns an error telling
  you to print questions as markdown instead. Do exactly that.
- The deck blocks the turn until submitted — don't call it speculatively in
  parallel with long-running tools.

---

## How it works

- **Skills** — the package bundles Matt Pocock's `grilling` + `grill-me`
  skills verbatim (MIT, see ATTRIBUTION.md). The `grill_deck` tool is wired to
  them via its prompt guidelines: during a grilling session the model presents
  each round through the deck instead of markdown.
- **State** — each submitted round is appended to the session as a custom
  entry (`grill-deck-round`; revisions as `grill-deck-revision`). State is
  rebuilt from the session on `session_start`, so it survives `/compact`,
  `/resume`, and restarts.
- **UI** — a `ctx.ui.custom()` component (pattern from the pi
  `questionnaire.ts` example); the embedded editor handles custom answers.

## Install / update / uninstall

```bash
# from the enterprise npm registry (user scope)
pi install npm:@evreke/pi-grill-deck@1.3.1

# or project scope, shared with your team via .pi/settings.json
pi install -l npm:@evreke/pi-grill-deck@1.3.1

# update
pi update npm:@evreke/pi-grill-deck

# uninstall
pi remove npm:@evreke/pi-grill-deck
```

Manual install (no registry) — copy the package files into the global
extensions directory:

```bash
~/.pi/agent/extensions/grill-deck/
├── index.ts        # the extension
└── onboarding.md   # this file
```

Running sessions pick up the install on their next session (`/new`,
`/resume`, restart) — or `/reload` in the current one. Install it **once**:
loading the npm package and a manual copy at the same time would register the
tool twice.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Agent prints markdown questions instead of opening the deck | Tell it: "present every round through the grill_deck tool in a single call" |
| `grill_deck 0 questions` flashes in the transcript | Cosmetic — the call header renders while arguments stream in |
| Herdr automation: keys don't type text | `herdr agent send-keys` takes logical keys only (`a`, `enter`, `ctrl+s`); raw text goes through `herdr pane send-text <pane> "…"` |
