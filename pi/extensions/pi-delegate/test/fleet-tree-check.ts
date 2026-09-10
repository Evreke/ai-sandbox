/**
 * fleet-UX wave 2, stage 2 — grouping + tree + fold contract checks.
 *
 * Run with: bun test/fleet-tree-check.ts   (from extensions/pi-delegate)
 *
 * Covers (report-ux-tree.json + report-ux-fold.json, per brief-impl-tree):
 *   - groupWorkerViews: group key `dir :: orchestratorSessionPath`, legacy
 *     fail-open ("owner?" — never "foreign"), same-dir two-session split,
 *     mixed degraded-self edge (mine worktree + unknown tabs → flat group).
 *   - rankGroups: most actionable member first; ties mine < owner? <
 *     foreign, then slug; within-group order preserved.
 *   - fold state machine (§4 exact): folded default, Tab toggle no-op when
 *     nothing foldable, module-level session memory.
 *   - header/folded/mega line builders: `▼ slug · live/total live · owner ·
 *     ctx↑max%` (max, dropped when unknown); `~ <class> <slug> · N workers ·
 *     counts… · idle <age>` (self-describing words, non-zero only, order
 *     live blocked hot-ctx question rep; stale age tail ownership-scoped);
 *     >6 groups mega-line guard.
 *   - renderFleet goldens at innerW 58/78/98 (folded + expanded) against the
 *     prod-prep-shaped fixture; all-mine stage-1 regression golden;
 *     group-atomic height window; 40-col header degrade; visibleWidth of
 *     EVERY line ≤ innerW; tree glyphs single-width.
 *   v1.12.1 (§22): the `s` stale flag — isFleetStale threshold matrix, every-
 *     member rule, flag order L B ! Q v s, non-zero-only, mega threading,
 *     pinned folded golden at innerW 78 (fixed clock).
 *   v1.13.0 (fleet-UX wave 4): the `s` LETTER is retired — its exact
 *     condition (isFleetStale, every member ≥30 min) now drives the age
 *     tail `idle <age>` with an ownership-scoped remedy (/delegate-teardown
 *     on MINE groups only, `owner can tear down` on foreign/owner?); new
 *     checks: age formatting, mine-vs-foreign tails, stale ordering
 *     tiebreak, stale-aware trim priority, legend parity presence + framing
 *     line + packLegend two-line cap. Goldens deliberately regenerated.
 */

import {
	fleetAgeText,
	fleetFoldToggle,
	fleetFoldUnfolded,
	groupFoldedText,
	groupHeaderText,
	groupWorkerViews,
	isFleetStale,
	megaFoldedText,
	packLegend,
	rankGroups,
	renderFleet,
	MEGA_GROUP_LIMIT,
	type FleetRow,
	type GroupStatsRow,
} from "../src/fleet.ts";
import { stripAnsi, visibleWidth } from "../src/fleet.ts";
import {
	DIR,
	FOREIGN,
	MINE,
	NOW_MS,
	frow,
	fixture,
	megaFixture,
	mineFixture,
	PLAIN_THEME,
	staleFixture,
} from "./fleet-tree-fixture.ts";
import {
	GOLDEN_ALL_MINE_80,
	GOLDEN_EXPANDED_100,
	GOLDEN_EXPANDED_60,
	GOLDEN_EXPANDED_80,
	GOLDEN_FOLDED_100,
	GOLDEN_FOLDED_60,
	GOLDEN_FOLDED_80,
	GOLDEN_FOLDED_FRESH_MEMBER_80,
	GOLDEN_FOLDED_STALE_80,
	GOLDEN_MEGA_FOLDED_80,
	GOLDEN_WINDOW_EXPANDED_80,
	GOLDEN_WINDOW_FOLDED_80,
} from "./fleet-tree-goldens.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const plain = PLAIN_THEME as never;
const render = (rows: FleetRow[], width: number, unfolded: boolean, terminalRows?: number, nowMs?: number) =>
	renderFleet({ rows, width, unfolded, terminalRows, nowMs, theme: plain });
const deepEq = (a: unknown[], b: unknown[]) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// groupWorkerViews — key build, fail-open, two-session split, mixed edge
// ---------------------------------------------------------------------------

{
	const g = groupWorkerViews(fixture());
	check(
		"G1 one group for same dir+session, key is `dir :: path`",
		g.length === 1 && g[0].key === `${DIR} :: ${FOREIGN}` && g[0].slug === "prod-prep" && g[0].cls === "foreign",
		JSON.stringify(g.map((x) => [x.key, x.cls])),
	);
	check("G1b 4 members in encounter (sortViews) order", g[0].rows.map((r) => r.view.name).join(",") === "sec-impl,ux-impl,sec-audit,ux-research");
}

{
	const other = frow("w2", {}, { dir: "/tmp/exchange/other-task" });
	const g = rankGroups(groupWorkerViews([fixture()[0], other]));
	check(
		"G2 two dirs → two groups, slug per dir",
		g.length === 2 && g[0].slug === "other-task" && g[1].slug === "prod-prep",
		JSON.stringify(g.map((x) => x.slug)),
	);
}

{
	// Legacy manifest (no orchestratorSessionPath) → owner? bucket, NEVER foreign.
	const legacy = frow("old-a", { ownership: "unknown", orchestratorSessionPath: undefined });
	const g = groupWorkerViews([legacy]);
	check(
		"G3 legacy fail-open: owner? group, never foreign",
		g.length === 1 && g[0].cls === "owner?" && !groupFoldedText(g[0], g[0].rows).includes("foreign"),
		groupFoldedText(g[0], g[0].rows),
	);check(
	"G3b folded/header text tags it owner?",
	groupFoldedText(g[0], g[0].rows).startsWith("~ owner? prod-prep") &&
		groupHeaderText(g[0], g[0].rows).includes("· owner? ·"),
	`${groupFoldedText(g[0], g[0].rows)} | ${groupHeaderText(g[0], g[0].rows)}`,
);
}

{
	// Same dir, TWO different orchestrator sessions → two groups (+legacy third).
	// All-working tie → class rank applies: owner? < foreign, so the legacy
	// bucket ranks BEFORE the two foreign sessions (spec: mine<owner?<foreign).
	const a = frow("wa", { orchestratorSessionPath: "/s/a.jsonl" });
	const b = frow("wb", { orchestratorSessionPath: "/s/b.jsonl" });
	const legacy = frow("wc", { ownership: "unknown", orchestratorSessionPath: undefined });
	const g = rankGroups(groupWorkerViews([a, b, legacy]));
	check(
		"G4 same-dir two-session split + separate legacy bucket (owner? ranks first on tie)",
		g.length === 3 &&
			g[0].key === `${DIR} :: unknown` && g[0].cls === "owner?" &&
			g[1].key === `${DIR} :: /s/a.jsonl` && g[1].cls === "foreign" &&
			g[2].key === `${DIR} :: /s/b.jsonl` && g[2].cls === "foreign",
		JSON.stringify(g.map((x) => [x.key, x.cls])),
	);
}

{
	// Degraded self-id edge: same session path group holds a mine worktree
	// (checkoutPath fallback) + unknown tabs → group is MINE → renders FLAT
	// (zero regression; per-row glyphs keep the truth).
	const a = frow("wa", { ownership: "mine" });
	const b = frow("wb", { ownership: "unknown" });
	const g = groupWorkerViews([a, b]);
	check(
		"G5 any-mine group (degraded-self mixed edge) → mine/flat",
		g.length === 1 && g[0].cls === "mine" && groupWorkerViews([a, b]).filter((x) => x.cls !== "mine").length === 0,
		JSON.stringify(g.map((x) => x.cls)),
	);
}

// ---------------------------------------------------------------------------
// rankGroups — most actionable member, class ties, slug tiebreak
// ---------------------------------------------------------------------------

{
	const idleF = frow("i1", {}, { status: "idle" });
	const blockedF = frow("b1", { orchestratorSessionPath: "/s/x.jsonl" }, { dir: "/tmp/exchange/zzz", status: "blocked" });
	const doneF = frow("d1", { orchestratorSessionPath: "/s/y.jsonl" }, { dir: "/tmp/exchange/ddd", status: "done" });
	const g = rankGroups(groupWorkerViews([doneF, idleF, blockedF]));
	check(
		"R-A blocked group ranks first (most actionable member)",
		g.length === 3 && g[0].rows[0].view.status === "blocked" && g[1].rows[0].view.status === "idle" && g[2].rows[0].view.status === "done",
		JSON.stringify(g.map((x) => x.rows[0].view.status)),
	);
}

{
	const mk = (name: string, cls: "mine" | "foreign" | "owner?", status: GroupStatsRow["view"]["status"]) =>
		frow(name, { ownership: cls === "mine" ? "mine" : cls === "owner?" ? "unknown" : "foreign", orchestratorSessionPath: cls === "owner?" ? undefined : `/s/${name}.jsonl` }, { status });
	// All-working tie: mine < owner? < foreign.
	const g = rankGroups(groupWorkerViews([mk("f1", "foreign", "working"), mk("o1", "owner?", "working"), mk("m1", "mine", "working")]));
	check(
		"R-B working tie: mine < owner? < foreign",
		g.map((x) => x.cls).join(",") === "mine,owner?,foreign",
		JSON.stringify(g.map((x) => x.cls)),
	);
}

{
	const a = frow("zz", { orchestratorSessionPath: "/s/1.jsonl" }, { dir: "/tmp/exchange/aaa", status: "idle" });
	const b = frow("aa", { orchestratorSessionPath: "/s/2.jsonl" }, { dir: "/tmp/exchange/zzz", status: "idle" });
	const g = rankGroups(groupWorkerViews([b, a]));
	check(
		"R-C class+status tie → slug ascending",
		g.map((x) => x.slug).join(",") === "aaa,zzz",
		JSON.stringify(g.map((x) => x.slug)),
	);
}

{
	const rows = [frow("b-second", {}, { status: "idle" }), frow("a-first", {}, { status: "idle" })];
	const g = groupWorkerViews(rows);
	check("R-D within-group order = input (sortViews) order", g[0].rows.map((r) => r.view.name).join(",") === "b-second,a-first");
}

// ---------------------------------------------------------------------------
// header / folded / mega line builders
// ---------------------------------------------------------------------------

{
	const rows = fixture();
	check(
		"H1 header shape: ▼ slug · live/total live · owner · ctx↑max%",
		groupHeaderText({ slug: "prod-prep", cls: "foreign" }, rows) === "▼ prod-prep · 2/4 live · foreign · ctx↑63%",
		groupHeaderText({ slug: "prod-prep", cls: "foreign" }, rows),
	);
	const cold = rows.map((r) => ({ ...r, percent: 0 }));
	check("H2 ctx segment dropped when no pct known", !groupHeaderText({ slug: "prod-prep", cls: "owner?" }, cold).includes("ctx↑"));
	check(
		"H3 folded counts non-zero only, order live blocked hot-ctx question rep",
		groupFoldedText({ slug: "prod-prep", cls: "foreign" }, rows) === "~ foreign prod-prep · 4 workers · 2 live · 2 rep" &&
			groupFoldedText({ slug: "prod-prep", cls: "foreign" }, rows.filter((r) => !r.view.reportExists)) === "~ foreign prod-prep · 2 workers · 2 live",
		groupFoldedText({ slug: "prod-prep", cls: "foreign" }, rows),
	);
	const alarm = rows.map((r, i) => ({ ...r, percent: i === 0 ? 91 : r.percent, mail: i === 1 ? ("Q?" as const) : r.mail, view: { ...r.view, status: i === 2 ? ("blocked" as const) : r.view.status } }));
	check(
		"H4 full count matrix live blocked hot-ctx question rep (live = working+blocked = 3, 4th stays idle)",
		groupFoldedText({ slug: "t", cls: "owner?" }, alarm) === "~ owner? t · 4 workers · 3 live · 1 blocked · 1 hot-ctx · 1 question · 2 rep",
		groupFoldedText({ slug: "t", cls: "owner?" }, alarm),
	);
	const m = rankGroups(groupWorkerViews(megaFixture(8)));
	check(
		"H5 mega-line: `~ foreign · N workers in M tasks · counts…`",
		megaFoldedText(m) === "~ foreign · 8 workers in 8 tasks · 8 live",
		megaFoldedText(m),
	);
	const mixed = megaFixture(8).slice(6).map((r) => ({ ...r, ownership: "unknown" as const, orchestratorSessionPath: undefined }));
	check(
		"H5b mega mixed foreign+owner? stays honest",
		megaFoldedText([...m.slice(0, 6), ...groupWorkerViews(mixed)]) === "~ foreign+owner? · 8 workers in 8 tasks · 8 live",
		megaFoldedText([...m.slice(0, 6), ...groupWorkerViews(mixed)]),
	);
}

// ---------------------------------------------------------------------------
// fold state machine (§4 exact: module scope = session memory)
// ---------------------------------------------------------------------------

{
	check("F1 first-open default is FOLDED (module fresh)", fleetFoldUnfolded() === false);
	fleetFoldToggle(0);
	check("F2 Tab with nothing foldable is a no-op", fleetFoldUnfolded() === false);
	fleetFoldToggle(1);
	check("F3 toggle flips", fleetFoldUnfolded() === true);
	fleetFoldToggle(3);
	check("F4 session memory: state survives (second toggle returns to folded)", fleetFoldUnfolded() === false);
	// restored: unfolded === false for the goldens below (they pass the flag
	// explicitly, but keep the module state tidy anyway).
}

// ---------------------------------------------------------------------------
// renderFleet — goldens (plain theme → readable ASCII expectations)
// ---------------------------------------------------------------------------

{
	check("V1 folded golden innerW 58 (box 60)", deepEq(render(fixture(), 60, false), GOLDEN_FOLDED_60));
	check("V2 folded golden innerW 78 (box 80)", deepEq(render(fixture(), 80, false), GOLDEN_FOLDED_80));
	check("V3 folded golden innerW 98 (box 100)", deepEq(render(fixture(), 100, false), GOLDEN_FOLDED_100));
	check("V4 expanded golden innerW 58", deepEq(render(fixture(), 60, true), GOLDEN_EXPANDED_60));
	check("V5 expanded golden innerW 78", deepEq(render(fixture(), 80, true), GOLDEN_EXPANDED_80));
	check("V6 expanded golden innerW 98", deepEq(render(fixture(), 100, true), GOLDEN_EXPANDED_100));
	check(
		"V11 folded golden WITH s flag, fixed clock (innerW 78)",
		deepEq(render(staleFixture(), 80, false, undefined, NOW_MS), GOLDEN_FOLDED_STALE_80),
	);
	check(
		"V12 every-member guard golden: one fresh member → no s (innerW 78)",
		deepEq(
			render(
				[...staleFixture().slice(1), frow("fresh", {}, { status: "idle" })],
				80,
				false,
				undefined,
				NOW_MS,
			),
			GOLDEN_FOLDED_FRESH_MEMBER_80,
		),
	);
}

{
	// REAL-ANSI theme render strips to EXACTLY the plain render — ANSI never
	// affects geometry (fitRow/trunc are ANSI-tolerant, F3 in fleet-render-check).
	const ansiTheme = { fg: (_c: string, text: string) => `\x1b[36m${text}\x1b[0m` } as never;
	const themedFolded = renderFleet({ rows: fixture(), width: 80, unfolded: false, theme: ansiTheme }).map(stripAnsi);
	const themedExpanded = renderFleet({ rows: fixture(), width: 80, unfolded: true, theme: ansiTheme }).map(stripAnsi);
	check(
		"V7 real-ANSI themed render strips to the plain render (both states)",
		deepEq(themedFolded, GOLDEN_FOLDED_80) && deepEq(themedExpanded, GOLDEN_EXPANDED_80),
	);
}

{
	// All-mine fleet: stage-1 flat shape — no hint, no header/folded lines.
	const out = render(mineFixture(), 80, false);
	check("V8 all-mine regression golden (byte-identical stage-1 shape)", deepEq(out, GOLDEN_ALL_MINE_80));
	check(
		"V8b no tree/fold artifacts when nothing is foldable",
		!out.join("\n").includes("Tab ") && !out.join("\n").includes("▼") && !out.join("\n").includes("~ "),
	);
}

{
	// Mega guard: >6 foldable groups folded → ONE mega-line, no per-group lines.
	const out = render(megaFixture(8), 80, false);
	check(
		"V9 mega guard: one line, no per-group headers",
		deepEq(out, GOLDEN_MEGA_FOLDED_80) && out.filter((l) => l.includes("~ foreign · 8 workers in 8 tasks")).length === 1 && !out.join("\n").includes("▼"),
	);
	check(
		"V9b unfolded renders all 8 groups (guard is fold-state-only)",
		render(megaFixture(8), 80, true).filter((l) => l.includes("▼")).length === 8,
	);
	check("V9c guard threshold is exactly MEGA_GROUP_LIMIT", MEGA_GROUP_LIMIT === 6);
}

{
	// Group-atomic height window: tiny pane (maxVisible 2) — expanded group
	// (header+4 children = 5 lines) hides WHOLE; folded state fits the line.
	// (12 rows: chrome grew to 8 in wave 4 — 2-line legend + framing line.)
	const rows = [mineFixture()[0], ...fixture()];
	const expanded = render(rows, 80, true, 12);
	const folded = render(rows, 80, false, 12);
	check(
		"V10 group-atomic: header never without children (whole group → more-line)",
		deepEq(expanded, GOLDEN_WINDOW_EXPANDED_80) && expanded.join("\n").includes("… and 4 more") && !expanded.join("\n").includes("▼"),
	);
	check(
		"V10b folded state fits the same tiny pane without loss",
		deepEq(folded, GOLDEN_WINDOW_FOLDED_80) && !folded.join("\n").includes("… and"),
	);
}

// ---------------------------------------------------------------------------
// the stale age tail (v1.13.0, §22.3) — condition unchanged, words not letters
// ---------------------------------------------------------------------------

{
	const iso = (msBack: number) => new Date(NOW_MS - msBack).toISOString();
	check("S1 collected exactly 30 min ago → stale (≥ threshold)", isFleetStale(iso(30 * 60_000), NOW_MS));
	check("S1b 31 min ago → stale", isFleetStale(iso(31 * 60_000), NOW_MS));
	check("S1c just under 30 min → not stale", !isFleetStale(iso(30 * 60_000 - 1), NOW_MS));
	check(
		"S1d absent/empty/garbage/future stamps → never stale (a flag is a claim)",
		!isFleetStale(undefined, NOW_MS) &&
			!isFleetStale("", NOW_MS) &&
			!isFleetStale("not-a-date", NOW_MS) &&
			!isFleetStale(new Date(NOW_MS + 60_000).toISOString(), NOW_MS),
	);

	const rows = staleFixture();
	check(
		"S2 stale tail: age of the OLDEST member, owner-side remedy (foreign)",
		groupFoldedText({ slug: "prod-prep", cls: "foreign" }, rows, NOW_MS) === "~ foreign prod-prep · 4 workers · 2 live · 2 rep · idle 34m · owner can tear down",
		groupFoldedText({ slug: "prod-prep", cls: "foreign" }, rows, NOW_MS),
	);
	// Every-member rule: one never-collected member suppresses the group claim.
	const mixed = [...rows.slice(1), frow("fresh", {}, { status: "idle" })];
	check(
		"S3 one non-stale member suppresses the age tail (every-member rule)",
		groupFoldedText({ slug: "prod-prep", cls: "foreign" }, mixed, NOW_MS) === "~ foreign prod-prep · 4 workers · 1 live · 2 rep",
		groupFoldedText({ slug: "prod-prep", cls: "foreign" }, mixed, NOW_MS),
	);
	check(
		"S4 tail is non-zero-only: fully fresh group renders without an age tail",
		groupFoldedText({ slug: "prod-prep", cls: "foreign" }, fixture(), NOW_MS) === "~ foreign prod-prep · 4 workers · 2 live · 2 rep",
		groupFoldedText({ slug: "prod-prep", cls: "foreign" }, fixture(), NOW_MS),
	);
	const staleMega = megaFixture(8).map((r) => ({ ...r, collectedAt: iso(45 * 60_000) }));
	check(
		"S5 megaFoldedText threads the clock and appends the owner-side tail",
		megaFoldedText(rankGroups(groupWorkerViews(staleMega), NOW_MS), NOW_MS) === "~ foreign · 8 workers in 8 tasks · 8 live · idle 45m · owner can tear down",
		megaFoldedText(rankGroups(groupWorkerViews(staleMega), NOW_MS), NOW_MS),
	);
	check("S6 default clock works (no throw when nowMs omitted)", typeof groupFoldedText({ slug: "t", cls: "foreign" }, rows) === "string");
}

// ---------------------------------------------------------------------------
// width safety + degrade
// ---------------------------------------------------------------------------

{
	// fitRow clips content to innerW−1 then pads to innerW, so EVERY line —
	// borders, grid rows, group headers, folded/mega lines, legend — is
	// EXACTLY innerW+2 visible columns. That is the §19 width regression
	// invariant (content-clip cases live in fleet-render-check F1–F3).
	let allFit = true;
	const details: string[] = [];
	for (const width of [40, 41, 58, 60, 78, 80, 98, 100, 137]) {
		const innerW = Math.max(40, Math.min(width, 100)) - 2;
		for (const unfolded of [false, true]) {
			for (const rows of [fixture(), mineFixture(), megaFixture(8), [...mineFixture(), ...fixture(), ...megaFixture(8)]]) {
				for (const l of render(rows, width, unfolded, 24)) {
					const w = visibleWidth(stripAnsi(l));
					if (w !== innerW + 2) {
						allFit = false;
						details.push(`w=${width} unfolded=${unfolded} line=${w} vs ${innerW + 2}: ${stripAnsi(l).slice(0, 44)}`);
					}
				}
			}
		}
	}
	check("W1 EVERY rendered line is exactly innerW+2 (never past the border)", allFit, details.slice(0, 3).join("; "));
}

{
	const out = render(fixture(), 40, true);
	check(
		"W2 40-col box: header degrades by survival order (slug · live kept)",
		out.some((l) => l.startsWith("│ ▼ prod-prep · 2/4 live · foreign · …")),
		out.find((l) => l.includes("▼")) ?? "",
	);
	check(
		"W2b 40-col folded line: identity (class + slug + worker count) survives first",
		render(fixture(), 40, false).some((l) => l.includes("~ foreign prod-prep · 4 workers")),
		render(fixture(), 40, false).find((l) => l.includes("~ foreign")) ?? "",
	);
}

{
	const glyphs = ["├", "└", "▼", "~", "●", "○", "◌"];
	check(
		"W3 tree/ownership glyphs stay single-width",
		glyphs.every((g) => visibleWidth(g) === 1),
		glyphs.map((g) => `${g}=${visibleWidth(g)}`).join(" "),
	);
}

{
	const hintFolded = render(fixture(), 80, false)[1];
	const hintExpanded = render(fixture(), 80, true)[1];
	check(
		"W4 hint swaps with fold state, only when foldable",
		hintFolded.includes("— Tab unfold") && hintExpanded.includes("— Tab fold") && !render(mineFixture(), 80, false)[1].includes("Tab"),
		`${hintFolded} | ${hintExpanded}`,
	);
}

// ---------------------------------------------------------------------------
// fleet-UX wave 4 — age format, ownership-scoped remedy, stale ordering +
// trim, legend parity + framing (report-lex/report-act/report-pulse fixes)
// ---------------------------------------------------------------------------

{
	check(
		"W5 fleetAgeText: minutes under an hour, hours+minutes beyond",
		fleetAgeText(0) === "0m" &&
			fleetAgeText(31 * 60_000) === "31m" &&
			fleetAgeText(59 * 60_000) === "59m" &&
			fleetAgeText(60 * 60_000) === "1h0m" &&
			fleetAgeText(226 * 60_000) === "3h46m" &&
			fleetAgeText(1500 * 60_000) === "25h0m",
		`${fleetAgeText(0)} ${fleetAgeText(31 * 60_000)} ${fleetAgeText(226 * 60_000)}`,
	);
}

{
	const stale = staleFixture();
	const mineTail = groupFoldedText({ slug: "prod-prep", cls: "mine" }, stale, NOW_MS);
	const foreignTail = groupFoldedText({ slug: "prod-prep", cls: "foreign" }, stale, NOW_MS);
	const ownerTail = groupFoldedText({ slug: "prod-prep", cls: "owner?" }, stale, NOW_MS);
	check(
		"W6 remedy is ownership-scoped: /delegate-teardown on MINE only, owner-side elsewhere",
		mineTail.endsWith("idle 34m (/delegate-teardown)") &&
			foreignTail.endsWith("idle 34m · owner can tear down") &&
			ownerTail.endsWith("idle 34m · owner can tear down") &&
			!foreignTail.includes("/delegate-teardown") &&
			!ownerTail.includes("/delegate-teardown"),
		`${mineTail} | ${foreignTail}`,
	);
}

{
	// Ordering (report-pulse fix 2): ONE new tiebreak layer — fully-stale
	// groups sort below otherwise-equal fresh ones (class rank still first).
	const fresh = frow("fw", { orchestratorSessionPath: "/s/f.jsonl" }, { dir: "/tmp/exchange/zzz", status: "working" });
	const staleA = frow("sa", { orchestratorSessionPath: "/s/s.jsonl", collectedAt: new Date(NOW_MS - 31 * 60_000).toISOString() }, { dir: "/tmp/exchange/aaa", status: "working" });
	const g = rankGroups(groupWorkerViews([staleA, fresh]), NOW_MS);
	check(
		"W7 fully-stale group sorts below an otherwise-equal fresh group (slug would say otherwise)",
		g.map((x) => x.slug).join(",") === "zzz,aaa",
		g.map((x) => x.slug).join(","),
	);
	const staleMine = frow("sm", { ownership: "mine", orchestratorSessionPath: MINE, collectedAt: new Date(NOW_MS - 31 * 60_000).toISOString() }, { status: "working" });
	const g2 = rankGroups(groupWorkerViews([staleA, staleMine]), NOW_MS);
	check("W7b class rank precedes the stale tiebreak (mine-stale still first)", g2[0].cls === "mine", g2.map((x) => x.cls).join(","));
}

{
	// Trim priority (report-pulse fix 2): fresh blocks fill the window first;
	// a stale block is admitted only after EVERY fresh block is shown — a
	// live row is never hidden while a stale-group row is visible.
	const staleRow = frow("st0", { collectedAt: new Date(NOW_MS - 31 * 60_000).toISOString() }, { dir: "/tmp/exchange/stale", status: "idle" });
	const freshRows = [0, 1, 2].map((i) => frow(`fw${i}`, { orchestratorSessionPath: "/s/f.jsonl" }, { dir: "/tmp/exchange/fresh", status: "working" }));
	const rows = [...freshRows, staleRow];
	// Expanded blocks: fresh = header+3 = 4 lines, stale = header+1 = 2 lines;
	// chrome 8 → maxVisible = terminalRows − 10.
	const t5 = render(rows, 80, true, 15, NOW_MS).join("\n"); // maxVisible 5: fresh fits, stale (4+2>5) hidden
	check(
		"W8 trim: stale group dropped before any fresh row, group-atomic",
		t5.includes("▼ fresh") && !t5.includes("▼ stale") && t5.includes("… and 1 more"),
		t5,
	);
	const t6 = render(rows, 80, true, 16, NOW_MS).join("\n"); // maxVisible 6: everything fits
	check("W8b trim: stale group admitted once every fresh block is shown", t6.includes("▼ stale") && !t6.includes("… and"), t6);
	const t3 = render(rows, 80, true, 13, NOW_MS).join("\n"); // maxVisible 3: fresh (4) hides whole; stale must NOT show
	check("W8c trim: no stale-group row visible while a fresh group is hidden", !t3.includes("▼") && t3.includes("… and 4 more"), t3);
}

{
	// Legend parity (report-lex fix 3) + framing line (report-act fix 1).
	const flat = render(mineFixture(), 100, true).join("\n");
	check(
		"W9 FLAT legend keys every surface token: owner? untraceable, probe dash, tree glyphs, token arrows",
		flat.includes("owner? untraceable") && flat.includes("— probe") && flat.includes("├└ group") && flat.includes("↑↓ in/out"),
		flat.slice(flat.lastIndexOf("●")),
	);
	check("W9b all-mine fleet renders no framing line", !flat.includes("another session's fleet"));
	const fold = render(staleFixture(), 100, false, undefined, NOW_MS).join("\n");
	check(
		"W9c FOLD legend is a worked example + minimal key (not a token list)",
		fold.includes("e.g. ~ foreign prod-prep · 4 workers · 2 live · 2 rep · idle 31m") &&
			fold.includes("live=working/blocked") &&
			fold.includes("rep=report landed") &&
			fold.includes("idle=collected ≥30m"),
	);
	check(
		"W9d framing line renders with any foreign/owner? group on screen (folded + expanded)",
		fold.includes("○ ◌ = another session's fleet — informational; only its owner can act") &&
			render(fixture(), 100, true).join("\n").includes("only its owner can act"),
	);
	check(
		"W9e packLegend: one line when everything fits, two max, single wide segment stays one line",
		packLegend(["aa", "bb", "cc"], 40).length === 1 &&
			packLegend(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd"], 25).length === 2 &&
			packLegend(["single-long-segment-exceeding-budget"], 5).length === 1,
	);
}

// ---------------------------------------------------------------------------

console.log(failures === 0 ? "\nALL TREE/FOLD CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
