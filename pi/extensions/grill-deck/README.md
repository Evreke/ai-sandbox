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
pi install npm:@evreke/pi-grill-deck
```

or project-scoped (shared with your team via `.pi/settings.json`):

```bash
pi install -l npm:@evreke/pi-grill-deck
```

New sessions pick it up automatically; `/reload` hot-loads it into the current one.

## The experience

You ask pi to grill you about a decision. Instead of markdown, your editor is
replaced by the deck — every question of the round on one screen, the focused
one expanded with the agent's recommendation:

```
 grill deck · 5 questions · 1 answered · model-authored — verify before accepting
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
tree and come back in a later round.

### Keys

| Key | Action |
|---|---|
| `↑` `↓` | move between questions |
| `Enter` | open the options view — recommendation pre-highlighted as option 1 |
| `a` | accept the recommendation (quick path, no options view) |
| `A` | accept **all** recommendations at once |
| `1`–`9` | pick a numbered option (in options view) |
| `e` | write a custom answer (free text, saved verbatim) |
| `s` | defer — keep the question open for a later round |
| `ctrl+s` | submit manually — a fresh deck also auto-submits once every question is answered or deferred (a `/grill` revision session always uses `ctrl+s` so several answers can be changed first) |
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

This package bundles two skills derived from **[mattpocock/skills](https://github.com/mattpocock/skills)**
(MIT — see [ATTRIBUTION.md](./ATTRIBUTION.md)):

- **`grilling-fork`** — the interview methodology: map decisions as a design tree,
  work the frontier in rounds, dispatch sub-agents for facts, don't act until
  shared understanding is confirmed. Adapted from the upstream `grilling`
  skill and renamed with the `-fork` suffix (see below).
- **`grill-me`** — the user-facing entry point ("run a grilling session").

Together with the bundled `grill_deck` tool this gives you the complete
workflow out of one install: the skill drives *what* to ask and in which
order, the tool presents each round as an interactive deck. The tool's prompt
guidelines tell the model to use the deck for grilling rounds — the skill text
ships with the package and is co-versioned with it.

**Backward compatibility:** the fork keeps the upstream methodology core
verbatim — the design tree, working in rounds, the frontier definition,
sub-agent fact-finding, the confirmation gate — and tries to stay drop-in
compatible for a session: the same trigger phrases, the same session arc
(rounds until shared understanding, then confirmation). It is nevertheless
deliberately modified: rounds are presented through the deck, the round
contract is stricter, and termination has an exploration guard. The exact
inventory lives in the [CHANGELOG](./CHANGELOG.md) under *Skill divergence
from upstream*.

**Working alongside the upstream `grilling` skill:** the methodology skill is
deliberately named `grilling-fork`, not `grilling` — if you also have Matt
Pocock's `grilling` installed (e.g. straight from `mattpocock/skills`), the
two coexist as separate skills and nothing needs to be removed. The pairing
between the tool and the fork skill is enforced at three levels:

1. **System-prompt guideline.** While the package is installed, the
   `grill_deck` tool's guideline names `grilling-fork` as the session
   protocol and prefers it over other grilling-style skills — the binding
   holds no matter which skill a phrase-match would otherwise pick.
2. **Description precedence marker.** The fork's description says it is a
   deck-first fork and to prefer it over the plain `grilling` skill — so the
   choice is anchored already at skill-discovery level.
3. **Explicit command.** `/skill:grilling-fork` forces the fork
   deterministically (pi-native, always works).

The bundled `grill-me` keeps its upstream name; if you also installed it
globally, your copy wins (pi keeps the first skill on a name collision and
notes it at startup). You can toggle package resources explicitly with
`pi config`.

## Trust & security

Everything inside a deck — question text, choices, recommendations — is
authored by the model. It is rendered as-is except for terminal escape
sequences, which are stripped so they can't spoof UI state or touch your
clipboard, and the deck header reminds you to verify before accepting.
Rounds are capped at 32 questions / 2,000-character fields, and data replayed
from the session file is validated before it reaches the UI or the model.
The full security audit is maintained in the development repository.

## How it works

Each submitted round is appended to the pi session as a custom entry
(`grill-deck-round`, revisions as `grill-deck-revision`) and rebuilt on
`session_start` — state survives `/compact`, `/resume`, and restarts.

## Development

Pure logic (sanitization, session-replay validation, answer formatting) lives
in `lib.ts`, unit-tested with `npm test` (Vitest). `REGRESSION.md` documents
the interactive TUI checklist to run before a release.

## Docs

Full user + agent onboarding: [onboarding.md](./onboarding.md).

## Compatibility

pi (interactive TUI mode). In non-interactive modes the tool degrades
gracefully and instructs the model to print questions as markdown instead.
