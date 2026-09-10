/**
 * fleet-UX stage 2 — PINNED expected overlay renders (goldens) for
 * test/fleet-tree-check.ts. Plain (identity) theme; each array is the exact
 * renderFleet() output for the prod-prep-shaped fixture in
 * test/fleet-tree-fixture.ts at the named width/state. These are
 * expectations, not computed values — if a check fails here, the render
 * changed and the diff IS the review artifact. Regenerate only deliberately.
 *
 * v1.12.1: FOLD_LEGEND gained `s stale` (all folded-state goldens regenerate)
 * and two s-flag goldens joined (fixed clock NOW_MS): the stale group line
 * `-- L2 v2 s` and the every-member guard (one fresh member → no `s`).
 *
 * v1.13.0 (fleet-UX wave 4 — DELIBERATE REGEN, the diff is the review
 * artifact): folded grammar is self-describing (`~ foreign prod-prep · 4
 * workers · 2 live · 2 rep · idle 34m · owner can tear down` — the letter
 * alphabet `xN -- L B ! Q v s` is retired), FLAT legend gained parity keys
 * and both legends pack to ≤2 dim lines, the foreign framing line joined
 * (folded+expanded, any foreign/owner? group), and the window goldens moved
 * to terminalRows 12 (chrome grew by the second legend line + framing).
 * Window shows shrink accordingly (folded tiny-pane golden now hides the
 * foreign group → more-line). Expanded MY rows are byte-identical.
 */

export const GOLDEN_FOLDED_60: string[] = [
	"╭──────────────────────────────────────────────────────────╮",
	"│ pi-delegate fleet — 4 worker(s) — q to close — Tab unfo… │",
	"│                                                          │",
	"│ ~ foreign prod-prep · 4 workers · 2 live · 2 rep         │",
	"│                                                          │",
	"│ ● yours                                                  │",
	"│ e.g. ~ foreign prod-prep · 4 workers · 2 live · 2 rep ·… │",
	"│ ○ ◌ = another session's fleet — informational; only its… │",
	"╰──────────────────────────────────────────────────────────╯",
];

export const GOLDEN_FOLDED_80: string[] = [
	"╭──────────────────────────────────────────────────────────────────────────────╮",
	"│ pi-delegate fleet — 4 worker(s) — q to close — Tab unfold                    │",
	"│                                                                              │",
	"│ ~ foreign prod-prep · 4 workers · 2 live · 2 rep                             │",
	"│                                                                              │",
	"│ ● yours · e.g. ~ foreign prod-prep · 4 workers · 2 live · 2 rep · idle 31m   │",
	"│ live=working/blocked · rep=report landed · idle=collected ≥30m               │",
	"│ ○ ◌ = another session's fleet — informational; only its owner can act        │",
	"╰──────────────────────────────────────────────────────────────────────────────╯",
];

export const GOLDEN_FOLDED_100: string[] = [
	"╭──────────────────────────────────────────────────────────────────────────────────────────────────╮",
	"│ pi-delegate fleet — 4 worker(s) — q to close — Tab unfold                                        │",
	"│                                                                                                  │",
	"│ ~ foreign prod-prep · 4 workers · 2 live · 2 rep                                                 │",
	"│                                                                                                  │",
	"│ ● yours · e.g. ~ foreign prod-prep · 4 workers · 2 live · 2 rep · idle 31m                       │",
	"│ live=working/blocked · rep=report landed · idle=collected ≥30m                                   │",
	"│ ○ ◌ = another session's fleet — informational; only its owner can act                            │",
	"╰──────────────────────────────────────────────────────────────────────────────────────────────────╯",
];

export const GOLDEN_EXPANDED_60: string[] = [
	"╭──────────────────────────────────────────────────────────╮",
	"│ pi-delegate fleet — 4 worker(s) — q to close — Tab fold  │",
	"│                                                          │",
	"│ ▼ prod-prep · 2/4 live · foreign · ctx↑63%               │",
	"│○ ├ sec-i… working deleg… ✗ --  ↑31.2k ↓18.7k (41% of 25… │",
	"│○ ├ ux-im… working deleg… ✗ --  ↑52.8k ↓34.9k (63% of 25… │",
	"│○ ├ sec-a… idle    -      ✓ --  ↑5.4k ↓3.9k (17% of 524k) │",
	"│○ └ ux-re… idle    -      ✓ --  ↑8.1k ↓6.2k (23% of 524k) │",
	"│                                                          │",
	"│ ● mine ○ foreign ◌ owner? untraceable                    │",
	"│ blocked→working→idle→done→unknown · ✓/✗ report · — prob… │",
	"│ ○ ◌ = another session's fleet — informational; only its… │",
	"╰──────────────────────────────────────────────────────────╯",
];

export const GOLDEN_EXPANDED_80: string[] = [
	"╭──────────────────────────────────────────────────────────────────────────────╮",
	"│ pi-delegate fleet — 4 worker(s) — q to close — Tab fold                      │",
	"│                                                                              │",
	"│ ▼ prod-prep · 2/4 live · foreign · ctx↑63%                                   │",
	"│○ ├ sec-impl    working delegate/sec-impl ✗ --  ↑31.2k ↓18.7k (41% of 250k)   │",
	"│○ ├ ux-impl     working delegate/ux-impl  ✗ --  ↑52.8k ↓34.9k (63% of 250k)   │",
	"│○ ├ sec-audit   idle    -                 ✓ --  ↑5.4k ↓3.9k (17% of 524k)     │",
	"│○ └ ux-research idle    -                 ✓ --  ↑8.1k ↓6.2k (23% of 524k)     │",
	"│                                                                              │",
	"│ ● mine ○ foreign ◌ owner? untraceable · blocked→working→idle→done→unknown    │",
	"│ ✓/✗ report · — probe · Q?/A→ mailbox · ├└ group · ↑↓ in/out · 2s refresh     │",
	"│ ○ ◌ = another session's fleet — informational; only its owner can act        │",
	"╰──────────────────────────────────────────────────────────────────────────────╯",
];

export const GOLDEN_EXPANDED_100: string[] = [
	"╭──────────────────────────────────────────────────────────────────────────────────────────────────╮",
	"│ pi-delegate fleet — 4 worker(s) — q to close — Tab fold                                          │",
	"│                                                                                                  │",
	"│ ▼ prod-prep · 2/4 live · foreign · ctx↑63%                                                       │",
	"│○ ├ sec-impl    working delegate/sec-impl ✗ --  ↑31.2k ↓18.7k (41% of 250k)                       │",
	"│○ ├ ux-impl     working delegate/ux-impl  ✗ --  ↑52.8k ↓34.9k (63% of 250k)                       │",
	"│○ ├ sec-audit   idle    -                 ✓ --  ↑5.4k ↓3.9k (17% of 524k)                         │",
	"│○ └ ux-research idle    -                 ✓ --  ↑8.1k ↓6.2k (23% of 524k)                         │",
	"│                                                                                                  │",
	"│ ● mine ○ foreign ◌ owner? untraceable · blocked→working→idle→done→unknown · ✓/✗ report · — probe │",
	"│ Q?/A→ mailbox · ├└ group · ↑↓ in/out · 2s refresh                                                │",
	"│ ○ ◌ = another session's fleet — informational; only its owner can act                            │",
	"╰──────────────────────────────────────────────────────────────────────────────────────────────────╯",
];

export const GOLDEN_ALL_MINE_80: string[] = [
	"╭──────────────────────────────────────────────────────────────────────────────╮",
	"│ pi-delegate fleet — 2 worker(s) — q to close                                 │",
	"│                                                                              │",
	"│● impl-a working delegate/impl-a ✗ --  ↑31.2k ↓18.7k (41% of 250k)            │",
	"│● impl-b blocked delegate/impl-b ✗ Q?  ↑31.2k ↓18.7k (83% of 250k)            │",
	"│                                                                              │",
	"│ ● mine ○ foreign ◌ owner? untraceable · blocked→working→idle→done→unknown    │",
	"│ ✓/✗ report · — probe · Q?/A→ mailbox · ├└ group · ↑↓ in/out · 2s refresh     │",
	"╰──────────────────────────────────────────────────────────────────────────────╯",
];

export const GOLDEN_MEGA_FOLDED_80: string[] = [
	"╭──────────────────────────────────────────────────────────────────────────────╮",
	"│ pi-delegate fleet — 8 worker(s) — q to close — Tab unfold                    │",
	"│                                                                              │",
	"│ ~ foreign · 8 workers in 8 tasks · 8 live                                    │",
	"│                                                                              │",
	"│ ● yours · e.g. ~ foreign prod-prep · 4 workers · 2 live · 2 rep · idle 31m   │",
	"│ live=working/blocked · rep=report landed · idle=collected ≥30m               │",
	"│ ○ ◌ = another session's fleet — informational; only its owner can act        │",
	"╰──────────────────────────────────────────────────────────────────────────────╯",
];

export const GOLDEN_FOLDED_STALE_80: string[] = [
	"╭──────────────────────────────────────────────────────────────────────────────╮",
	"│ pi-delegate fleet — 4 worker(s) — q to close — Tab unfold                    │",
	"│                                                                              │",
	"│ ~ foreign prod-prep · 4 workers · 2 live · 2 rep · idle 34m · owner can tea… │",
	"│                                                                              │",
	"│ ● yours · e.g. ~ foreign prod-prep · 4 workers · 2 live · 2 rep · idle 31m   │",
	"│ live=working/blocked · rep=report landed · idle=collected ≥30m               │",
	"│ ○ ◌ = another session's fleet — informational; only its owner can act        │",
	"╰──────────────────────────────────────────────────────────────────────────────╯",
];

export const GOLDEN_FOLDED_FRESH_MEMBER_80: string[] = [
	"╭──────────────────────────────────────────────────────────────────────────────╮",
	"│ pi-delegate fleet — 4 worker(s) — q to close — Tab unfold                    │",
	"│                                                                              │",
	"│ ~ foreign prod-prep · 4 workers · 1 live · 2 rep                             │",
	"│                                                                              │",
	"│ ● yours · e.g. ~ foreign prod-prep · 4 workers · 2 live · 2 rep · idle 31m   │",
	"│ live=working/blocked · rep=report landed · idle=collected ≥30m               │",
	"│ ○ ◌ = another session's fleet — informational; only its owner can act        │",
	"╰──────────────────────────────────────────────────────────────────────────────╯",
];

export const GOLDEN_WINDOW_EXPANDED_80: string[] = [
	"╭──────────────────────────────────────────────────────────────────────────────╮",
	"│ pi-delegate fleet — 5 worker(s) — q to close — Tab fold                      │",
	"│                                                                              │",
	"│● impl-a working delegate/impl-a ✗ --  ↑31.2k ↓18.7k (41% of 250k)            │",
	"│ … and 4 more (trim the fleet: /delegate-teardown)                            │",
	"│                                                                              │",
	"│ ● mine ○ foreign ◌ owner? untraceable · blocked→working→idle→done→unknown    │",
	"│ ✓/✗ report · — probe · Q?/A→ mailbox · ├└ group · ↑↓ in/out · 2s refresh     │",
	"│ ○ ◌ = another session's fleet — informational; only its owner can act        │",
	"╰──────────────────────────────────────────────────────────────────────────────╯",
];

export const GOLDEN_WINDOW_FOLDED_80: string[] = [
	"╭──────────────────────────────────────────────────────────────────────────────╮",
	"│ pi-delegate fleet — 5 worker(s) — q to close — Tab unfold                    │",
	"│                                                                              │",
	"│● impl-a working delegate/impl-a ✗ --  ↑31.2k ↓18.7k (41% of 250k)            │",
	"│ ~ foreign prod-prep · 4 workers · 2 live · 2 rep                             │",
	"│                                                                              │",
	"│ ● yours · e.g. ~ foreign prod-prep · 4 workers · 2 live · 2 rep · idle 31m   │",
	"│ live=working/blocked · rep=report landed · idle=collected ≥30m               │",
	"│ ○ ◌ = another session's fleet — informational; only its owner can act        │",
	"╰──────────────────────────────────────────────────────────────────────────────╯",
];

