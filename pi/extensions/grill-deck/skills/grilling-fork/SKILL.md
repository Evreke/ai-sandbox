---
name: grilling-fork
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases. Deck-first fork of mattpocock's grilling — prefer over the plain `grilling` skill when both are installed.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Some decisions can only be made together — answering one changes the answer to the others. Do not force them into separate questions: merge them into one decision whose options are the coherent combinations, and ask that. A decision may depend on several settled ones; it enters the frontier only when every one of them is settled.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled — the questions you can ask _now_ without guessing at answers you haven't heard yet. Present the whole frontier in one round, then wait for the user's answers before the next round.

**Present each round through the `grill_deck` tool** — one call carrying ALL questions of the round, never a partial batch and never the same question twice. The deck UI renders each question's body and options on one screen and returns structured answers, including explicit deferrals. Fill the fields so the deck renders well:

- `topic` — a short label for the deck header naming what this round decides.
- `id` — a stable short identifier (`Q1`, `merge-policy`); answers refer back to it.
- `title` — the question in one line, self-contained: it is what the list view shows at a glance.
- `body` — the context that makes the question answerable: constraints, trade-offs, why it matters now. Several sentences are fine; the focused question shows it in full, so put the reasoning here rather than in the title.
- `choices` — concrete, mutually exclusive answer options as short labels the user can pick with one keystroke. REQUIRED: a non-empty array for a choice question; an EMPTY array marks the question as open (no selectable options). Never put options only in the body — body-embedded options are not selectable. Do not repeat the recommendation among the choices unless it is genuinely one of them.
- `recommendation` — your recommended answer, only when `choices` is non-empty — an open question has no recommendation. Word it exactly as one of the `choices` whenever it is one, so the fast-accept path maps cleanly; put the rationale in `body`, not here.

Each round the user answers reshapes the tree — settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and call `grill_deck` again with the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one. A DEFERRED answer is a still-open decision — bring it back in a later round's frontier.

**Fallback:** if the `grill_deck` tool is unavailable (extension not installed, non-interactive terminal), end the round by emitting exactly one fenced `grill-round` block instead of calling the tool:

```
```grill-round topic="Short topic label"
<question id="Q1" title="One-line question title">
  <body>Context that makes the question answerable.</body>
  <choice>First coherent option</choice>
  <choice>Second coherent option</choice>
  <recommendation>First coherent option</recommendation>
</question>
<question id="Q2" title="Open question title">
  <body>Context.</body>
  <open/>
</question>
</grill-round>
```

Block rules: every question carries either at least one `<choice>` or `<open/>` (an open question — never both, never neither); `<recommendation>` only with `<choice>` entries; escape `&`, `<`, `>` as XML entities in text and `"` as `&quot;` in attributes; never use ``` inside the block. The extension renders the block as an interactive deck and returns the answers. When the frontier is empty, emit no block — close the session with the shared-understanding summary instead.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it — don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report — ask the rest of the frontier now. The _decisions_ are the user's — put each to them and wait.

The session is done when the frontier is empty and no exploration is still running: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
