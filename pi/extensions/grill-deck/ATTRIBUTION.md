# Skill attribution

The bundled skills are copied **verbatim** from:

**[mattpocock/skills](https://github.com/mattpocock/skills)** — "Skills for Real
Engineers. Straight from my .agents directory." by Matt Pocock, MIT licensed.

- `skills/grilling/` — the interview methodology: design tree, frontier
  rounds, fact-finding sub-agents, "don't act until shared understanding".
- `skills/grill-me/` — the user-facing entry point that starts a grilling
  session (`disable-model-invocation: true`).

**Pinned snapshot:** upstream commit
[`8b78b531ab965735c5dc74f6f7a219e1e37326df`](https://github.com/mattpocock/skills/tree/8b78b531ab965735c5dc74f6f7a219e1e37326df)
— both `SKILL.md` files match that snapshot byte-for-byte. Upstream `main` has
since moved ahead (em-dash removal, round-template changes), so re-copying
from `main` will change text.

To update: pick an upstream commit, re-copy
`skills/productivity/grilling/` and `skills/productivity/grill-me/`, and move
the pin above. Diff before committing — skill files are model-executed
instructions, so treat upstream changes like any supply-chain update.

## License of the bundled skills

The bundled skills are redistributed under their upstream MIT license. The
full license text below is included verbatim as required by that license; it
covers the bundled skill files. The rest of this package (`index.ts`,
`lib.ts`, the `grill_deck` tool) is separate work licensed under this
package's own [MIT LICENSE](./LICENSE).

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The `grill_deck` tool from this package is designed to present the question
rounds that the `grilling` skill describes: its prompt guidelines instruct the
model to use the deck instead of markdown whenever a grilling session is
running. No changes to the skill text are required for this wiring.
