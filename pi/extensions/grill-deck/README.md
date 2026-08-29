# pi-grill-deck

An interactive **question deck** extension for [pi](https://pi.dev), the AI coding
assistant. It replaces the "dump a wall of markdown questions and hope the
free-text reply maps back" pattern with a structured TUI: the agent hands all
questions of a round to one tool, you answer them in a single screen, and the
agent gets clean structured answers back.

Built for grilling-style sessions — design-tree interviews where each round
presents the whole *frontier* of askable questions — but it works for any batch
of questions (checklists, requirement gathering, triage).

## Install

```bash
pi install npm:pi-grill-deck@1.0.0
```

or project-scoped (shared with your team via `.pi/settings.json`):

```bash
pi install -l npm:pi-grill-deck@1.0.0
```

New sessions pick it up automatically; `/reload` hot-loads it into the current one.

## The experience

You ask pi to grill you about a decision. Instead of markdown, your editor is
replaced by the deck — every question of the round on one screen, the focused
one expanded with the agent's recommendation:

```
 grill deck · 5 questions · 1 answered
─────────────────────────────────────
  ✓ Q1 Scope: what does 'PR review format' actually cover?
        (a) + (b) + (c) — description template…
> · Q2 What is the primary pain driving this?
      What hurts today that this format must fix?
      ➡️ rec: (a) + (d) — vague descriptions and missing…
  · Q3 Scope of adoption: one repo or org-wide?
```

Answer with single keystrokes, submit, and the agent recomputes the frontier
and opens the next deck. Deferred questions stay visibly open in the design
tree and come back in a later round. A progress widget lives above your editor:

```
⚑ grill: 2 rounds · settled 12 · deferred 1 (Q3) · /grill to review
```

### Keys

| Key | Action |
|---|---|
| `↑` `↓` | move between questions |
| `Enter` | **accept the recommendation** (opens options when there is none or to revise) |
| `Space` | open the options view (browse choices, custom, defer) |
| `A` | accept **all** recommendations at once |
| `1`–`9` | pick a numbered option (in options view) |
| `e` | write a custom answer (free text, saved verbatim) |
| `s` | defer — keep the question open for a later round |
| `ctrl+s` | submit the round |
| `Esc` | cancel the deck |

`/grill` reopens the last deck with answers prefilled for review/revision.

## For agents

Call `grill_deck` instead of printing questions as markdown: **one call per
round**, containing the *entire frontier* — every question whose prerequisites
are already settled. Each question: stable `id`, one-line `title`, optional
`body`, optional `choices`, and your `recommendation`. The result marks every
answer as accepted / choice / custom / **DEFERRED** (still open — re-ask it
later with the same `id`). When the frontier is empty, summarize the shared
understanding and wait for the user's confirmation before acting.

## Skills included

This package bundles two skills from **[mattpocock/skills](https://github.com/mattpocock/skills)**
(MIT — see [ATTRIBUTION.md](./ATTRIBUTION.md)), copied verbatim:

- **`grilling`** — the interview methodology: map decisions as a design tree,
  work the frontier in rounds, dispatch sub-agents for facts, don't act until
  shared understanding is confirmed.
- **`grill-me`** — the user-facing entry point ("run a grilling session").

Together with the bundled `grill_deck` tool this gives you the complete
workflow out of one install: the skill drives *what* to ask and in which
order, the tool presents each round as an interactive deck. The tool's prompt
guidelines tell the model to use the deck for grilling rounds — the skill text
stays untouched, so upstream updates remain a verbatim re-copy.

If you already installed the skills separately (e.g. via
`setup-matt-pocock-skills`), disable the duplicate copy with `pi config`.

## How it works

Each submitted round is appended to the pi session as a custom entry
(`grill-deck-round`, revisions as `grill-deck-revision`) and rebuilt on
`session_start` — state survives `/compact`, `/resume`, and restarts.

## Docs

Full user + agent onboarding: [onboarding.md](./onboarding.md).

## Compatibility

pi (interactive TUI mode). In non-interactive modes the tool degrades
gracefully and instructs the model to print questions as markdown instead.
