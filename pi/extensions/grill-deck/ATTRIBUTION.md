# Skill attribution

The bundled skills are copied **verbatim** from:

**[mattpocock/skills](https://github.com/mattpocock/skills)** — "Skills for Real
Engineers. Straight from my .agents directory." by Matt Pocock, MIT licensed.

- `skills/grilling/` — the interview methodology: design tree, frontier
  rounds, fact-finding sub-agents, "don't act until shared understanding".
- `skills/grill-me/` — the user-facing entry point that starts a grilling
  session (`disable-model-invocation: true`).

MIT License — Copyright (c) Matt Pocock. The extension code in this package
(`index.ts`, the `grill_deck` tool) is separate and does not modify the skill
files. To update them, re-copy from the upstream repository.

The `grill_deck` tool from this package is designed to present the question
rounds that the `grilling` skill describes: its prompt guidelines instruct the
model to use the deck instead of markdown whenever a grilling session is
running. No changes to the skill text are required for this wiring.
