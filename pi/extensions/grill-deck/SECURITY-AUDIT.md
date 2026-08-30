# Security Audit — `pi-grill-deck` v1.2.1

> **UPDATE:** all findings below are remediated in **v1.2.2** (see “5. Remediation log”).

- **Target:** `pi/extensions/grill-deck` (repo `Evreke/ai-sandobx`, commit `8f541ea`)
- **Scope:** `index.ts` (676 LOC), `package.json`, bundled skills (`grilling`, `grill-me`), docs
- **Date:** 2026-08-29 (audit of HEAD at clone time)
- **Overall risk: LOW–MEDIUM** — no RCE, no filesystem/network access, no eval, no secrets handling. Main exposure is terminal-escape injection via model-controlled strings and unvalidated session replay.

---

## 1. Threat model

The extension renders **model-controlled text** (question `id`, `title`, `body`, `choices[]`, `recommendation`, `topic`) into the user's terminal and persists user answers into the session file. Relevant actors:

| Actor | Vector |
|---|---|
| The model (possibly steered by indirect prompt injection from repo content) | Crafts tool-call payloads shown in a trusted TUI |
| Tampered / shared session files | Poisoned `grill-deck-round` / `grill-deck-revision` custom entries replayed on `session_start` |
| npm supply chain (consumers of `pi-grill-deck`) | Install-time and bundled-content integrity |

---

## 2. Findings

### F1 — Terminal escape-sequence injection via model-controlled strings — **Medium**

**Where:** `execute()` (no sanitization of `params`), all render paths (`render()`, `updateWidget()`, `renderCall()`), which feed `wrapTextWithAnsi()` / `Text` from `@earendil-works/pi-tui`.

**Detail:** `wrapTextWithAnsi()` and `visibleWidth()` are ANSI-*aware* — they parse CSI/OSC/APC sequences and count them as zero-width — but they **preserve** them in output. The pi-tui alt-screen frame writer emits screen lines verbatim (`buffer += \x1b[row;1H\x1b[2K${line}`); sanitization (`stripTerminalSequences`) is only applied on the selection/copy path, never on the render path. The extension never calls `stripTerminalSequences`.

Consequently, a model (or a model steered by a malicious file it just read) can embed raw escape sequences in any question field and they reach the terminal:

- **SGR injection** (`\x1b[...m`): recolor/restyle subsequent text to fake trusted UI states — fake green `✓ answered` marks, fake warning lines, fake accent-colored "system" rows inside the deck.
- **OSC 52 clipboard overwrite** (`\x1b]52;c;<base64>\x07`): pi-tui itself uses OSC 52 for copy; many terminals honor it. A question title could silently replace the user's clipboard content.
- **OSC 0 window-title manipulation**, cursor-position games (mostly cosmetic; the per-frame full redraw bounds persistent damage).

**Impact:** UI spoofing inside a component whose whole purpose is to get fast, trusted confirmations (`Enter` = accept recommendation); clipboard manipulation. Exploit chain is realistic but multi-step: it requires the model to emit hostile field values, e.g. via indirect prompt injection from repo content during a grilling session about that repo.

**Recommendation:** sanitize at the trust boundary — in `execute()`, run every string field through `stripTerminalSequences` (already exported by `@earendil-works/pi-tui`) before storing/round-tripping; also sanitize in `replayFromSession()`.

---

### F2 — Unvalidated session replay (stored-content trust) — **Low–Medium**

**Where:** `replayFromSession()` — `entry.data as RoundRecord` with only `Array.isArray(d.questions)`; revision path checks `Array.isArray(d.answers)` but nothing else.

**Detail:** Replayed records are trusted without schema validation. Their fields (`title`, `recommendation`, answer `label`/`kind`) flow into (a) the TUI when `/grill` reopens the deck, (b) the progress widget, and (c) — after a revision — `pi.sendUserMessage(...)`, i.e. **back into the model context as user text**. Any writer of the session JSONL (another extension, a hand-edited or synced/shared session file) can therefore inject content that renders as trusted UI and is re-sent to the model as if the user said it. Prototype-pollution via `__proto__` is *not* possible here (spread uses `CreateDataProperty`), but type confusion is unguarded (e.g. `d.questions` elements that are `null` crash `render()` on `/grill`).

**Recommendation:** validate on replay: `round: number`, `questions: DeckQuestion[]` (shape-check each), answers with `kind ∈ {accepted, choice, custom, deferred}` and string `label`; drop malformed entries.

---

### F3 — Model content rendered in trusted UI chrome, with one-keystroke bulk accept — **Design / Informational**

**Where:** deck rendering; `Enter` accept-recommendation, `A` accept-all.

**Detail:** Agent-provided `recommendation` and `choices` are displayed with the same visual grammar as system UI (accent colors, `★`, `➡️ rec:`). Combined with `A` (accept all), a model compromised via indirect prompt injection could present leading questions ("Q1: Security patch required — Accept: run <hostile command>") and harvest quick accepts. This is inherent to the tool's purpose (the same trust exists in plain markdown questions), but the TUI makes acceptance cheaper and the content's origin is not labeled.

**Recommendation:** consider a small provenance cue in the deck header (e.g. "questions authored by the model — verify before accepting"); document the residual risk in README/onboarding.

---

### F4 — No payload size limits — **Low**

**Where:** `execute()`.

**Detail:** No caps on question count or field lengths. A runaway/hostile call can force the TUI to wrap and render megabytes each frame (the width cache in pi-tui is bounded, but wrapping is not), freezing the UI and bloating the session file. Not exploitable for code execution.

**Recommendation:** cap (e.g. ≤ 32 questions, ≤ 2 000 chars per field, truncate the rest).

---

### F5 — Bundled skills: "copied verbatim" claim is stale, no integrity pin — **Low (supply chain / doc accuracy)**

**Detail:** `ATTRIBUTION.md` says the two skills are copied **verbatim** from `mattpocock/skills` (MIT). Diffing against upstream `main` today shows drift in both `SKILL.md` files (em-dash vs colon punctuation, an added second example question upstream, and `grill-me`'s invocation line: upstream "Call the Skill tool with 'grilling'" vs bundled "Run a `/grilling` session"). The drift looks like an older upstream snapshot plus one adaptation — i.e. "verbatim" is no longer verifiably true. There is no upstream commit pin, so future re-copies ("re-copy from upstream" per ATTRIBUTION) have no integrity anchor. Skill files are model-executed instructions, so upstream drift is a (mild) prompt-content supply-chain surface. The `agents/openai.yaml` files do match upstream.

**Recommendation:** pin the upstream commit hash in `ATTRIBUTION.md`; either re-sync or reword "verbatim" to "adapted from".

---

### F6 — Minor / hygiene — **Informational**

- `README.md` install example pins `pi-grill-deck@1.0.0` while the package is `1.2.1` — doc drift; users pinning the README version get a stale release.
- `peerDependencies: "*"` for all three peers — conventional for pi extensions, but unpinned; acceptable.
- `onboarding.md` links `../../skills/grilling/SKILL.md` — broken relative path in the published-package context.
- `truncatePlain()` measures UTF-16 `.length`, not grapheme width — cosmetic only.
- `.gitignore` correctly excludes `.npmrc`, `.env`, `node_modules/`, `*.tgz` — good publishing hygiene; no secrets committed.
- `Esc` cancels the deck discarding all entered answers (annoyance only; the tool result explicitly tells the model not to immediately re-ask — good mitigation).

---

## 3. Verified clean

- **No dangerous primitives:** no `require`/`child_process`/`exec`/`spawn`, no `eval`/`new Function`, no dynamic import, no `fetch`/network, no `fs` access, no `process.env` reads.
- **No secrets or credentials** in any file.
- **No install scripts** in `package.json`; `files` whitelist is tight; only peer dependencies (no lockfile-able dep tree to poison).
- `grill-me` skill has `disable-model-invocation: true` — correct: user-only entry point.
- `/^[1-9]$/` option selection is bounds-checked; `submit()` refuses incomplete rounds; empty-question and non-TUI modes are handled; UI-failure and cancel paths return safe fallback text.
- Session storage via `pi.appendEntry` contains only questions/answers — no environment leakage beyond what the user typed and the model sent.

---

## 4. Priority fixes

1. **F1:** sanitize all model-supplied strings with `stripTerminalSequences()` in `execute()` and `replayFromSession()` (~10 lines).
2. **F2:** schema-validate replayed session entries before use.
3. **F4:** size caps on `questions` payload.
4. **F5/F6:** pin upstream skill commit; fix README version pin and broken onboarding link.

---

## 5. Remediation log (v1.2.2)

All fixes in `index.ts` unless noted; verified with `tsc --strict` (clean) and a behavioral test of `stripTerminalSequences` against SGR/OSC-52/OSC-0/cursor/OSC-8 payloads (all neutralized, legit text preserved).

- **F1 — fixed:** added `clean()` helper (escape-strip + length cap) applied to every model-supplied string in `execute()` / `sanitizeQuestion()`, to `topic` in the persisted record, to `renderCall()` args, and (defense in depth) to user-typed custom answers in `editor.onSubmit`.
- **F2 — fixed:** `replayFromSession()` now parses entries through `parseRoundRecord` / `parseAnswer` (strict per-item validation: integer round ≥ 1, `kind` in union, integer `choiceIndex` for choices, sanitized strings); malformed items are dropped instead of type-cast blindly.
- **F3 — mitigated:** deck header now shows `· model-authored — verify before accepting`; trust model documented in README (“Trust & security”).
- **F4 — fixed:** `MAX_QUESTIONS = 32` (tool returns guidance to defer the rest), `MAX_FIELD_LENGTH = 2_000` enforced inside `clean()`.
- **F5 — fixed:** `ATTRIBUTION.md` now pins upstream commit `8b78b531ab965735c5dc74f6f7a219e1e37326df` (verified byte-for-byte match for both `SKILL.md` files) and documents the re-sync procedure; README wording updated.
- **F6 — fixed:** README install examples pin `@1.2.2`; `onboarding.md` broken relative link fixed (`./skills/grilling/SKILL.md`); dead `DeckHandle` interface removed; UI examples in README/onboarding updated for the new header. `package.json` bumped to 1.2.2.

Residual risk (accepted): question text itself can still contain misleading *words* (e.g. a literal `✓` character) — sanitization removes control sequences, not persuasion; the header cue and the tool’s own cancel-handling guidance remain the mitigations, as for any model-authored UI.

---

## 6. Regression verification (live, v1.2.2)

End-to-end tested in a Herdr pane with real `pi --model zai/glm-5.3-flash` (isolated project `~/projects/grill-deck-regression`, extension loaded via `-ne -e <path>` to avoid the tool-name conflict with the globally installed copy). All features verified working after the security changes:

| # | Scenario | Result |
|---|---|---|
| R1 | Deck opens; `a`/`A` accept-all; `ctrl+s` submit; structured result; widget appears | ✅ `✓ Q1–Q3` accepted; `⚑ grill: 1 round · settled 3 · deferred 0` |
| R2 | Defer (`s`), options view on a no-recommendation question (`Enter` → numbered list), custom answer (`1` + typed text), accept (`a`), submit | ✅ DEFERRED / user-wrote / accepted all delivered to model; widget `settled 5 · deferred 1 (Q1)` |
| R3 | `Esc` cancel | ✅ cancel message with “do not re-ask” guidance; no round recorded; widget unchanged |
| R4 | 40-question call | ✅ rejected with “Too many questions (40)…” guidance; no deck |
| R5 | `/grill` revision | ✅ deck reopens with answers prefilled; changed answer detected; model receives “Revised answers for grill deck round 2”; widget `settled 6 · deferred 0` |
| R6 | Live escape injection: model sent real `ESC[31m`/BEL bytes in a title (via JSON `\u001b`) | ✅ rendered as clean text; ANSI-level read shows only theme styling — no `ESC[31m`, no BEL |
| R7 | Restart with `--continue` | ✅ widget rebuilt from session replay |
| R8 | Session-tamper: real entry payload poisoned (`kind: "hax"` + ESC-laced label), envelope untouched | ✅ invalid answer dropped (`settled 6→5`), label sanitized to plain text; malformed round entry (`round: "evil"`) rejected outright |

Session file on disk confirmed: exactly 2 `grill-deck-round` + 1 `grill-deck-revision` entries, well-formed; cancelled decks write nothing.

**Upstream observation (not a grill-deck issue):** pi core (`buildSessionContext`) can crash on hand-mangled session JSONL (e.g. synthetic entries with null fields, or parent chains broken mid-file) — reproducible independently of this extension’s code; extension replay never runs in that case. Worth reporting upstream if not already known.
